use anyhow::{Context, Result, bail};
use csv::{ReaderBuilder, WriterBuilder};
use rand::distributions::{Distribution, WeightedIndex};
use rand::{Rng, SeedableRng};
use rand_chacha::ChaCha8Rng;
use rayon::prelude::*;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::env;
use std::fs;
use std::io::{BufRead, BufReader, BufWriter, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, ChildStdout, Command, Stdio};

const DAYS: [i32; 3] = [-2, -1, 0];
const OSMIUM_PRODUCT: &str = "ASH_COATED_OSMIUM";
const ROOT_PRODUCT: &str = "INTARIAN_PEPPER_ROOT";
const PRODUCTS: [&str; 2] = [OSMIUM_PRODUCT, ROOT_PRODUCT];
const DEFAULT_TICKS_PER_DAY: usize = 10_000;
const TIMESTAMP_STEP: i32 = 100;
const TOMATO_HALF_TIE_FLIP_PROB: f64 = 0.0005;
const POSITION_LIMIT: i32 = 50;
const OSMIUM_TRADE_ACTIVE_PROB: f64 = 1252.0 / 30_000.0;
const ROOT_TRADE_ACTIVE_PROB: f64 = 1007.0 / 30_000.0;
const OSMIUM_SECOND_TRADE_PROB: f64 = 13.0 / 1252.0;
const ROOT_SECOND_TRADE_PROB: f64 = 4.0 / 1007.0;
const OSMIUM_TRADE_BUY_PROB: f64 = 647.0 / 1265.0;
const ROOT_TRADE_BUY_PROB: f64 = 493.0 / 1011.0;
const OSMIUM_MU: f64 = 10_000.0;
const OSMIUM_DEFAULT_PHI: f64 = 0.99778;
const OSMIUM_DEFAULT_SIGMA: f64 = 0.312;
const ROOT_BASE_MU: f64 = 12_000.0;
const ROOT_DAY_STRIDE: f64 = 1_000.0;
const OSMIUM_NEAR_BOT_PROB: f64 = 0.076;
const ROOT_NEAR_BOT_PROB: f64 = 0.045;
const STRATEGY_RUN_TIMEOUT_MS: u64 = 900;
// Bot 3 offsets: 2/3 passive, 1/3 aggressive, 50/50 within each group
// (old weighted offsets removed — calibration proved uniform with passive/aggressive structure)

const OSMIUM_MASKS: [(bool, bool, bool, bool); 12] = [
    (false, false, true, true),
    (false, true, false, true),
    (false, true, true, false),
    (false, true, true, true),
    (true, false, false, true),
    (true, false, true, false),
    (true, false, true, true),
    (true, true, false, false),
    (true, true, false, true),
    (true, true, true, false),
    (true, true, true, true),
    (false, false, false, false),
];
const OSMIUM_MASK_WEIGHTS: [u32; 12] = [861, 729, 775, 3048, 839, 763, 3206, 850, 2998, 3072, 12058, 801];

const ROOT_MASKS: [(bool, bool, bool, bool); 16] = [
    (false, false, false, false),
    (true, true, true, true),
    (false, false, true, true),
    (true, true, false, false),
    (true, false, false, false),
    (false, false, true, false),
    (true, false, true, true),
    (true, true, true, false),
    (true, false, true, false),
    (false, true, true, true),
    (true, true, false, true),
    (false, true, false, false),
    (false, false, false, true),
    (true, false, false, true),
    (false, true, true, false),
    (false, true, false, true),
];
const ROOT_MASK_WEIGHTS: [u32; 16] = [
    8286, 3098, 2784, 2755, 2616, 2612, 1495, 1478, 970, 816, 774, 705, 669, 372, 366, 204,
];

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum FvMode {
    Replay,
    Simulate,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum TradeMode {
    ReplayTimes,
    Simulate,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum TomatoSupport {
    Continuous,
    Half,
    Quarter,
}

#[derive(Clone, Debug)]
struct Config {
    output_dir: PathBuf,
    actual_dir: PathBuf,
    fv_mode: FvMode,
    trade_mode: TradeMode,
    tomato_support: TomatoSupport,
    osmium_phi: f64,
    osmium_sigma: f64,
    seed: u64,
    strategy_path: Option<PathBuf>,
    python_bin: String,
    sessions: usize,
    write_session_limit: usize,
    ticks_per_day: usize,
}

#[derive(Clone, Debug)]
struct ReplayData {
    osmium_fair_by_day: HashMap<i32, Vec<f64>>,
    trade_counts_by_key: HashMap<(i32, String), Vec<usize>>,
}

#[derive(Clone, Copy, Debug)]
enum HalfTieOrientation {
    Inward,
    Outward,
}

impl HalfTieOrientation {
    fn flip(self) -> Self {
        match self {
            HalfTieOrientation::Inward => HalfTieOrientation::Outward,
            HalfTieOrientation::Outward => HalfTieOrientation::Inward,
        }
    }
}

#[derive(Clone, Copy, Debug)]
struct TomatoLatentState {
    fair: f64,
    half_tie_orientation: HalfTieOrientation,
}

#[derive(Clone, Debug)]
struct DayOutput {
    day: i32,
    price_rows: Vec<PriceRow>,
    trade_rows: Vec<TradeRow>,
    trace_rows: Vec<TraceRow>,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum LevelOwner {
    Bot,
    Strategy,
}

#[derive(Clone, Debug)]
struct Level {
    price: i32,
    quantity: i32,
    owner: LevelOwner,
}

#[derive(Clone, Debug)]
struct SimBook {
    bids: Vec<Level>,
    asks: Vec<Level>,
}

#[derive(Clone, Debug)]
struct Fill {
    symbol: String,
    price: i32,
    quantity: i32,
    buyer: Option<String>,
    seller: Option<String>,
    timestamp: i32,
}

#[derive(Clone, Debug, Default)]
struct ProductLedger {
    position: i32,
    cash: f64,
}

#[derive(Clone, Copy, Debug, Default)]
struct RunningLinearFit {
    n: f64,
    sum_x: f64,
    sum_y: f64,
    sum_xx: f64,
    sum_yy: f64,
    sum_xy: f64,
}

impl RunningLinearFit {
    fn update(&mut self, x: f64, y: f64) {
        self.n += 1.0;
        self.sum_x += x;
        self.sum_y += y;
        self.sum_xx += x * x;
        self.sum_yy += y * y;
        self.sum_xy += x * y;
    }

    fn slope_per_step(&self) -> f64 {
        let denom = self.n * self.sum_xx - self.sum_x * self.sum_x;
        if denom.abs() < 1e-12 {
            0.0
        } else {
            (self.n * self.sum_xy - self.sum_x * self.sum_y) / denom
        }
    }

    fn r_squared(&self) -> f64 {
        let x_var = self.n * self.sum_xx - self.sum_x * self.sum_x;
        let y_var = self.n * self.sum_yy - self.sum_y * self.sum_y;
        if x_var.abs() < 1e-12 || y_var.abs() < 1e-12 {
            0.0
        } else {
            let cov = self.n * self.sum_xy - self.sum_x * self.sum_y;
            (cov * cov) / (x_var * y_var)
        }
    }
}

#[derive(Clone, Debug, Serialize)]
struct SessionSummary {
    session_id: usize,
    total_pnl: f64,
    emerald_pnl: f64,
    tomato_pnl: f64,
    emerald_position: i32,
    tomato_position: i32,
    emerald_cash: f64,
    tomato_cash: f64,
    total_slope_per_step: f64,
    total_r2: f64,
    emerald_slope_per_step: f64,
    emerald_r2: f64,
    tomato_slope_per_step: f64,
    tomato_r2: f64,
}

#[derive(Clone, Debug, Serialize)]
struct RunSummary {
    session_id: usize,
    day: i32,
    total_pnl: f64,
    emerald_pnl: f64,
    tomato_pnl: f64,
    total_slope_per_step: f64,
    total_r2: f64,
    emerald_slope_per_step: f64,
    emerald_r2: f64,
    tomato_slope_per_step: f64,
    tomato_r2: f64,
}

#[derive(Clone, Debug)]
struct SessionOutput {
    session_id: usize,
    summary: SessionSummary,
    run_summaries: Vec<RunSummary>,
    day_outputs: Vec<DayOutput>,
}

#[derive(Clone, Debug)]
struct Book {
    bids: Vec<(i32, i32)>,
    asks: Vec<(i32, i32)>,
}

#[allow(dead_code)]
#[derive(Debug, Deserialize)]
struct InputPriceRow {
    day: i32,
    timestamp: i32,
    product: String,
    bid_price_1: Option<i32>,
    bid_volume_1: Option<i32>,
    bid_price_2: Option<i32>,
    bid_volume_2: Option<i32>,
    bid_price_3: Option<i32>,
    bid_volume_3: Option<i32>,
    ask_price_1: Option<i32>,
    ask_volume_1: Option<i32>,
    ask_price_2: Option<i32>,
    ask_volume_2: Option<i32>,
    ask_price_3: Option<i32>,
    ask_volume_3: Option<i32>,
    mid_price: f64,
    profit_and_loss: f64,
}

#[allow(dead_code)]
#[derive(Debug, Deserialize)]
struct InputTradeRow {
    timestamp: i32,
    buyer: Option<String>,
    seller: Option<String>,
    symbol: String,
    currency: String,
    price: f64,
    quantity: i32,
}

#[derive(Clone, Debug, Serialize)]
struct PriceRow {
    day: i32,
    timestamp: i32,
    product: String,
    bid_price_1: Option<i32>,
    bid_volume_1: Option<i32>,
    bid_price_2: Option<i32>,
    bid_volume_2: Option<i32>,
    bid_price_3: Option<i32>,
    bid_volume_3: Option<i32>,
    ask_price_1: Option<i32>,
    ask_volume_1: Option<i32>,
    ask_price_2: Option<i32>,
    ask_volume_2: Option<i32>,
    ask_price_3: Option<i32>,
    ask_volume_3: Option<i32>,
    mid_price: f64,
    profit_and_loss: f64,
}

#[derive(Clone, Debug, Serialize)]
struct TradeRow {
    timestamp: i32,
    buyer: Option<String>,
    seller: Option<String>,
    symbol: String,
    currency: String,
    price: f64,
    quantity: i32,
}

#[derive(Clone, Debug, Serialize)]
struct TraceRow {
    day: i32,
    timestamp: i32,
    product: String,
    fair_value: f64,
    position: i32,
    cash: f64,
    mtm_pnl: f64,
}

#[derive(Debug, Serialize)]
struct WorkerTrade {
    symbol: String,
    price: i32,
    quantity: i32,
    buyer: Option<String>,
    seller: Option<String>,
    timestamp: i32,
}

#[derive(Debug, Serialize)]
struct WorkerOrderDepth {
    buy_orders: HashMap<String, i32>,
    sell_orders: HashMap<String, i32>,
}

#[derive(Debug, Serialize)]
struct WorkerRequest {
    #[serde(rename = "type")]
    request_type: String,
    timestamp: i32,
    timeout_ms: u64,
    trader_data: String,
    order_depths: HashMap<String, WorkerOrderDepth>,
    own_trades: HashMap<String, Vec<WorkerTrade>>,
    market_trades: HashMap<String, Vec<WorkerTrade>>,
    position: HashMap<String, i32>,
}

#[allow(dead_code)]
#[derive(Clone, Debug, Deserialize)]
struct WorkerOrder {
    symbol: String,
    price: i32,
    quantity: i32,
}

#[allow(dead_code)]
#[derive(Debug, Deserialize)]
struct WorkerResponse {
    orders: Option<HashMap<String, Vec<WorkerOrder>>>,
    conversions: Option<i32>,
    trader_data: Option<String>,
    stdout: Option<String>,
    error: Option<String>,
}

impl Config {
    fn from_args() -> Result<Self> {
        let mut config = Config {
            output_dir: PathBuf::from("../tmp/rust_simulator_output"),
            actual_dir: PathBuf::from("../prosperity-analysis/hidden_trader_detector/data/imc_round1/round1"),
            fv_mode: FvMode::Replay,
            trade_mode: TradeMode::ReplayTimes,
            tomato_support: TomatoSupport::Continuous,
            osmium_phi: OSMIUM_DEFAULT_PHI,
            osmium_sigma: OSMIUM_DEFAULT_SIGMA,
            seed: 20_260_401,
            strategy_path: None,
            python_bin: "python3".to_string(),
            sessions: 1,
            write_session_limit: 0,
            ticks_per_day: DEFAULT_TICKS_PER_DAY,
        };

        let mut args = env::args().skip(1);
        while let Some(arg) = args.next() {
            match arg.as_str() {
                "--output" => {
                    config.output_dir =
                        PathBuf::from(args.next().context("missing value for --output")?);
                }
                "--actual-dir" => {
                    config.actual_dir =
                        PathBuf::from(args.next().context("missing value for --actual-dir")?);
                }
                "--fv-mode" => {
                    let value = args.next().context("missing value for --fv-mode")?;
                    config.fv_mode = match value.as_str() {
                        "replay" => FvMode::Replay,
                        "simulate" => FvMode::Simulate,
                        other => bail!("unsupported --fv-mode {}", other),
                    };
                }
                "--trade-mode" => {
                    let value = args.next().context("missing value for --trade-mode")?;
                    config.trade_mode = match value.as_str() {
                        "replay-times" => TradeMode::ReplayTimes,
                        "simulate" => TradeMode::Simulate,
                        other => bail!("unsupported --trade-mode {}", other),
                    };
                }
                "--tomato-support" => {
                    let value = args.next().context("missing value for --tomato-support")?;
                    config.tomato_support = match value.as_str() {
                        "continuous" => TomatoSupport::Continuous,
                        "0.5" | "half" => TomatoSupport::Half,
                        "0.25" | "quarter" => TomatoSupport::Quarter,
                        other => bail!("unsupported --tomato-support {}", other),
                    };
                }
                "--osmium-phi" => {
                    config.osmium_phi = args
                        .next()
                        .context("missing value for --osmium-phi")?
                        .parse()
                        .context("invalid --osmium-phi")?;
                }
                "--osmium-sigma" => {
                    config.osmium_sigma = args
                        .next()
                        .context("missing value for --osmium-sigma")?
                        .parse()
                        .context("invalid --osmium-sigma")?;
                }
                "--seed" => {
                    config.seed = args
                        .next()
                        .context("missing value for --seed")?
                        .parse()
                        .context("invalid --seed")?;
                }
                "--strategy" => {
                    config.strategy_path = Some(PathBuf::from(
                        args.next().context("missing value for --strategy")?,
                    ));
                }
                "--python-bin" => {
                    config.python_bin = args.next().context("missing value for --python-bin")?;
                }
                "--sessions" => {
                    config.sessions = args
                        .next()
                        .context("missing value for --sessions")?
                        .parse()
                        .context("invalid --sessions")?;
                }
                "--write-session-limit" => {
                    config.write_session_limit = args
                        .next()
                        .context("missing value for --write-session-limit")?
                        .parse()
                        .context("invalid --write-session-limit")?;
                }
                "--ticks-per-day" => {
                    config.ticks_per_day = args
                        .next()
                        .context("missing value for --ticks-per-day")?
                        .parse()
                        .context("invalid --ticks-per-day")?;
                }
                other => bail!("unknown argument {}", other),
            }
        }

        Ok(config)
    }
}

fn main() -> Result<()> {
    let config = Config::from_args()?;
    let replay_data = ReplayData::load(&config)?;

    if config.strategy_path.is_some() {
        let outputs = run_backtests(&config, &replay_data)?;
        write_backtest_outputs(&config, &outputs)?;
        write_run_log(&config)?;
        return Ok(());
    }

    let outputs = DAYS
        .par_iter()
        .map(|day| generate_day(*day, &config, &replay_data))
        .collect::<Result<Vec<_>>>()?;

    write_outputs(&config, &outputs)?;
    write_run_log(&config)?;
    Ok(())
}

impl ReplayData {
    fn load(config: &Config) -> Result<Self> {
        let mut osmium_fair_by_day = HashMap::new();
        let mut trade_counts_by_key = HashMap::new();

        if config.fv_mode == FvMode::Replay {
            for day in DAYS {
                let prices = load_price_rows(&config.actual_dir, day)?;
                let mut rows: Vec<_> = prices
                    .into_iter()
                    .filter(|row| row.product == OSMIUM_PRODUCT)
                    .collect();
                rows.sort_by_key(|row| row.timestamp);
                let latent_state_estimate = rows
                    .iter()
                    .map(estimate_osmium_replay_fair)
                    .collect::<Vec<_>>();
                osmium_fair_by_day.insert(day, latent_state_estimate);
            }
        }

        if config.trade_mode == TradeMode::ReplayTimes {
            for day in DAYS {
                let trades = load_trade_rows(&config.actual_dir, day)?;
                for product in PRODUCTS {
                    let mut counts = vec![0usize; config.ticks_per_day];
                    for trade in trades.iter().filter(|row| row.symbol == product) {
                        let index = usize::try_from(trade.timestamp / TIMESTAMP_STEP)
                            .context("negative timestamp while loading replay trades")?;
                        if index < counts.len() {
                            counts[index] += 1;
                        }
                    }
                    trade_counts_by_key.insert((day, product.to_string()), counts);
                }
            }
        }

        Ok(Self {
            osmium_fair_by_day,
            trade_counts_by_key,
        })
    }
}

fn generate_day(day: i32, config: &Config, replay: &ReplayData) -> Result<DayOutput> {
    let mut rng = ChaCha8Rng::seed_from_u64(seed_for_day(config.seed, day));
    let osmium_fair = match config.fv_mode {
        FvMode::Replay => replay
            .osmium_fair_by_day
            .get(&day)
            .cloned()
            .context("missing replay osmium fair estimate")?,
        FvMode::Simulate => simulate_osmium_fair(day, config.ticks_per_day, config.osmium_phi, config.osmium_sigma, &mut rng),
    };

    let osmium_trade_counts = trade_counts_for(OSMIUM_PRODUCT, day, config, replay, &mut rng)?;
    let root_trade_counts = trade_counts_for(ROOT_PRODUCT, day, config, replay, &mut rng)?;

    let mut price_rows = Vec::with_capacity(config.ticks_per_day * PRODUCTS.len());
    let mut trade_rows = Vec::new();

    for tick in 0..config.ticks_per_day {
        let timestamp = (tick as i32) * TIMESTAMP_STEP;
        let osmium_book = make_osmium_book(osmium_fair[tick], &mut rng);
        let root_book = make_root_book(day, timestamp, &mut rng);

        price_rows.push(book_to_price_row(day, timestamp, OSMIUM_PRODUCT, &osmium_book));
        price_rows.push(book_to_price_row(day, timestamp, ROOT_PRODUCT, &root_book));

        for _ in 0..osmium_trade_counts[tick] {
            trade_rows.extend(sample_trade_rows(timestamp, OSMIUM_PRODUCT, &osmium_book, &mut rng));
        }
        for _ in 0..root_trade_counts[tick] {
            trade_rows.extend(sample_trade_rows(timestamp, ROOT_PRODUCT, &root_book, &mut rng));
        }
    }

    price_rows.sort_by(|a, b| {
        a.timestamp
            .cmp(&b.timestamp)
            .then(a.product.cmp(&b.product))
    });
    trade_rows.sort_by(|a, b| a.timestamp.cmp(&b.timestamp).then(a.symbol.cmp(&b.symbol)));

    Ok(DayOutput {
        day,
        price_rows,
        trade_rows,
        trace_rows: Vec::new(),
    })
}

fn write_outputs(config: &Config, outputs: &[DayOutput]) -> Result<()> {
    let round_dir = config.output_dir.join("round1");
    fs::create_dir_all(&round_dir)
        .with_context(|| format!("failed to create {}", round_dir.display()))?;

    for output in outputs {
        let price_path = round_dir.join(format!("prices_round_1_day_{}.csv", output.day));
        let trade_path = round_dir.join(format!("trades_round_1_day_{}.csv", output.day));

        let mut price_writer = WriterBuilder::new()
            .delimiter(b';')
            .from_path(&price_path)
            .with_context(|| format!("failed to open {}", price_path.display()))?;
        for row in &output.price_rows {
            price_writer.serialize(row)?;
        }
        price_writer.flush()?;

        let mut trade_writer = WriterBuilder::new()
            .delimiter(b';')
            .from_path(&trade_path)
            .with_context(|| format!("failed to open {}", trade_path.display()))?;
        for row in &output.trade_rows {
            trade_writer.serialize(row)?;
        }
        trade_writer.flush()?;
    }

    Ok(())
}

struct StrategyWorker {
    child: Child,
    stdin: BufWriter<ChildStdin>,
    stdout: BufReader<ChildStdout>,
}

impl StrategyWorker {
    fn spawn(config: &Config) -> Result<Self> {
        let strategy_path = config
            .strategy_path
            .as_ref()
            .context("missing strategy path")?
            .canonicalize()
            .with_context(|| "failed to canonicalize strategy path")?;
        let project_root = env::var("PROSPERITY4MCBT_ROOT")
            .map(PathBuf::from)
            .or_else(|_| {
                env::current_dir().map(|cwd| {
                    cwd.parent()
                        .map(Path::to_path_buf)
                        .unwrap_or(cwd)
                })
            })
            .context("failed to resolve project root for python strategy worker")?;
        let worker_path = project_root.join("scripts/python_strategy_worker.py");
        if !worker_path.is_file() {
            bail!(
                "python strategy worker not found at {}",
                worker_path.display()
            );
        }

        let mut child = Command::new(&config.python_bin)
            .arg(worker_path)
            .arg(strategy_path)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::inherit())
            .spawn()
            .context("failed to spawn python strategy worker")?;

        let stdin = BufWriter::new(child.stdin.take().context("missing worker stdin")?);
        let stdout = BufReader::new(child.stdout.take().context("missing worker stdout")?);

        Ok(Self {
            child,
            stdin,
            stdout,
        })
    }

    fn reset(&mut self) -> Result<()> {
        let payload = serde_json::json!({ "type": "reset" });
        self.send(&payload)?;
        let response = self.read_response()?;
        if let Some(error) = response.error {
            bail!("python worker reset failed: {}", error);
        }
        Ok(())
    }

    fn run(&mut self, request: &WorkerRequest) -> Result<WorkerResponse> {
        self.send(request)?;
        let response = self.read_response()?;
        if let Some(error) = &response.error {
            bail!("python worker failed: {}", error);
        }
        Ok(response)
    }

    fn send<T: Serialize>(&mut self, payload: &T) -> Result<()> {
        serde_json::to_writer(&mut self.stdin, payload)?;
        self.stdin.write_all(b"\n")?;
        self.stdin.flush()?;
        Ok(())
    }

    fn read_response(&mut self) -> Result<WorkerResponse> {
        let mut line = String::new();
        let bytes = self.stdout.read_line(&mut line)?;
        if bytes == 0 {
            bail!("python worker exited unexpectedly");
        }
        let response = serde_json::from_str::<WorkerResponse>(line.trim())
            .context("failed to decode python worker response")?;
        Ok(response)
    }
}

impl Drop for StrategyWorker {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

fn run_backtests(config: &Config, replay: &ReplayData) -> Result<Vec<SessionOutput>> {
    let mut outputs = (0..config.sessions)
        .into_par_iter()
        .map(|session_id| {
            run_backtest_session(session_id, session_id < config.write_session_limit, config, replay)
        })
        .collect::<Result<Vec<_>>>()?;
    outputs.sort_by_key(|output| output.session_id);
    Ok(outputs)
}

fn monte_carlo_session_day(session_id: usize) -> i32 {
    DAYS[session_id % DAYS.len()]
}

fn run_backtest_session(
    session_id: usize,
    capture_outputs: bool,
    config: &Config,
    replay: &ReplayData,
) -> Result<SessionOutput> {
    let mut worker = StrategyWorker::spawn(config)?;
    let mut day_outputs = Vec::with_capacity(1);
    let mut osmium_total = 0.0;
    let mut root_total = 0.0;
    let mut osmium_cash_total = 0.0;
    let mut root_cash_total = 0.0;
    let mut osmium_final_position = 0;
    let mut root_final_position = 0;
    let mut total_fit = RunningLinearFit::default();
    let mut osmium_fit = RunningLinearFit::default();
    let mut root_fit = RunningLinearFit::default();
    let mut global_step = 0usize;
    let mut run_summaries = Vec::with_capacity(1);
    let session_day = monte_carlo_session_day(session_id);

    for day in [session_day] {
        worker.reset()?;
        let mut rng = ChaCha8Rng::seed_from_u64(seed_for_session_day(config.seed, session_id, day));
        let osmium_fair = match config.fv_mode {
            FvMode::Replay => replay
                .osmium_fair_by_day
                .get(&day)
                .cloned()
                .context("missing replay osmium fair estimate")?,
            FvMode::Simulate => simulate_osmium_fair(day, config.ticks_per_day, config.osmium_phi, config.osmium_sigma, &mut rng),
        };

        let osmium_trade_counts = trade_counts_for(OSMIUM_PRODUCT, day, config, replay, &mut rng)?;
        let root_trade_counts = trade_counts_for(ROOT_PRODUCT, day, config, replay, &mut rng)?;

        let mut ledgers = HashMap::from([
            (OSMIUM_PRODUCT.to_string(), ProductLedger::default()),
            (ROOT_PRODUCT.to_string(), ProductLedger::default()),
        ]);
        let mut trader_data = String::new();
        let mut prev_own_trades = empty_trade_map();
        let mut prev_market_trades = empty_trade_map();
        let mut day_total_fit = RunningLinearFit::default();
        let mut day_osmium_fit = RunningLinearFit::default();
        let mut day_root_fit = RunningLinearFit::default();
        let mut day_step = 0usize;
        let mut price_rows = if capture_outputs {
            Vec::with_capacity(config.ticks_per_day * PRODUCTS.len())
        } else {
            Vec::new()
        };
        let mut trade_rows = Vec::new();
        let mut trace_rows = Vec::new();

        for tick in 0..config.ticks_per_day {
            let timestamp = (tick as i32) * TIMESTAMP_STEP;
            let osmium_book = make_osmium_book(osmium_fair[tick], &mut rng);
            let root_book = make_root_book(day, timestamp, &mut rng);

            if capture_outputs {
                price_rows.push(book_to_price_row(day, timestamp, OSMIUM_PRODUCT, &osmium_book));
                price_rows.push(book_to_price_row(day, timestamp, ROOT_PRODUCT, &root_book));
            }

            let order_depths = HashMap::from([
                (OSMIUM_PRODUCT.to_string(), book_to_worker_depth(&osmium_book)),
                (ROOT_PRODUCT.to_string(), book_to_worker_depth(&root_book)),
            ]);
            let position = ledgers
                .iter()
                .map(|(product, ledger)| (product.clone(), ledger.position))
                .collect::<HashMap<_, _>>();
            let request = WorkerRequest {
                request_type: "run".to_string(),
                timestamp,
                timeout_ms: STRATEGY_RUN_TIMEOUT_MS,
                trader_data: trader_data.clone(),
                order_depths,
                own_trades: fills_to_worker_trade_map(&prev_own_trades),
                market_trades: fills_to_worker_trade_map(&prev_market_trades),
                position,
            };
            let response = worker.run(&request)?;
            trader_data = response.trader_data.unwrap_or_default();

            let mut live_books = HashMap::from([
                (OSMIUM_PRODUCT.to_string(), book_to_sim_book(&osmium_book)),
                (ROOT_PRODUCT.to_string(), book_to_sim_book(&root_book)),
            ]);
            let strategy_orders = normalize_strategy_orders(response.orders.unwrap_or_default());
            let filtered_orders = enforce_strategy_limits(&strategy_orders, &ledgers);

            let mut own_trades_this_tick = empty_trade_map();
            let mut market_trades_this_tick = empty_trade_map();

            for product in PRODUCTS {
                let product_key = product.to_string();
                let orders = filtered_orders
                    .get(product)
                    .cloned()
                    .unwrap_or_default();
                let book = live_books
                    .get_mut(&product_key)
                    .context("missing live book")?;
                let ledger = ledgers.get_mut(&product_key).context("missing ledger")?;
                let fills = execute_strategy_orders(product, timestamp, book, ledger, &orders);
                if capture_outputs {
                    trade_rows.extend(fills.iter().map(fill_to_trade_row));
                }
                own_trades_this_tick.insert(product_key.clone(), fills);
            }

            for (product, count) in [(OSMIUM_PRODUCT, osmium_trade_counts[tick]), (ROOT_PRODUCT, root_trade_counts[tick])] {
                let product_key = product.to_string();
                let book = live_books
                    .get_mut(&product_key)
                    .context("missing live book for taker execution")?;
                let ledger = ledgers.get_mut(&product_key).context("missing ledger for taker execution")?;
                for _ in 0..count {
                    let market_buy = sample_trade_side(product, &mut rng);
                    let fills = execute_taker_trade(product, timestamp, book, ledger, market_buy, &mut rng);
                    for fill in fills {
                        let row = fill_to_trade_row(&fill);
                        if fill_involves_strategy(&fill) {
                            own_trades_this_tick.entry(product_key.clone()).or_default().push(fill);
                        } else {
                            market_trades_this_tick.entry(product_key.clone()).or_default().push(fill);
                        }
                        if capture_outputs {
                            trade_rows.push(row);
                        }
                    }
                }
            }

            if capture_outputs {
                for product in PRODUCTS {
                    let product_key = product.to_string();
                    let ledger = ledgers.get(&product_key).context("missing ledger for trace")?;
                    let fair = if product == OSMIUM_PRODUCT {
                        osmium_fair[tick]
                    } else {
                        root_fair_for_timestamp(day, timestamp)
                    };
                    trace_rows.push(TraceRow {
                        day,
                        timestamp,
                        product: product_key,
                        fair_value: fair,
                        position: ledger.position,
                        cash: ledger.cash,
                        mtm_pnl: ledger.cash + ledger.position as f64 * fair,
                    });
                }
            }

            let osmium_ledger = ledgers.get(OSMIUM_PRODUCT).context("missing osmium ledger for fit")?;
            let root_ledger = ledgers.get(ROOT_PRODUCT).context("missing root ledger for fit")?;
            let root_fair = root_fair_for_timestamp(day, timestamp);
            let osmium_mtm = osmium_ledger.cash + osmium_ledger.position as f64 * osmium_fair[tick];
            let root_mtm = root_ledger.cash + root_ledger.position as f64 * root_fair;
            let session_x = global_step as f64;
            let day_x = day_step as f64;
            osmium_fit.update(session_x, osmium_mtm);
            root_fit.update(session_x, root_mtm);
            total_fit.update(session_x, osmium_mtm + root_mtm);
            day_osmium_fit.update(day_x, osmium_mtm);
            day_root_fit.update(day_x, root_mtm);
            day_total_fit.update(day_x, osmium_mtm + root_mtm);
            global_step += 1;
            day_step += 1;

            prev_own_trades = own_trades_this_tick;
            prev_market_trades = market_trades_this_tick;
        }

        let final_timestamp = ((config.ticks_per_day.saturating_sub(1)) as i32) * TIMESTAMP_STEP;
        let osmium_fair_final = *osmium_fair.last().unwrap_or(&OSMIUM_MU);
        let root_fair_final = root_fair_for_timestamp(day, final_timestamp);
        let osmium_ledger = ledgers.get(OSMIUM_PRODUCT).context("missing osmium ledger")?;
        let root_ledger = ledgers.get(ROOT_PRODUCT).context("missing root ledger")?;
        let osmium_pnl = osmium_ledger.cash + osmium_ledger.position as f64 * osmium_fair_final;
        let root_pnl = root_ledger.cash + root_ledger.position as f64 * root_fair_final;

        osmium_total += osmium_pnl;
        root_total += root_pnl;
        osmium_cash_total += osmium_ledger.cash;
        root_cash_total += root_ledger.cash;
        osmium_final_position = osmium_ledger.position;
        root_final_position = root_ledger.position;

        run_summaries.push(RunSummary {
            session_id,
            day,
            total_pnl: osmium_pnl + root_pnl,
            emerald_pnl: osmium_pnl,
            tomato_pnl: root_pnl,
            total_slope_per_step: day_total_fit.slope_per_step(),
            total_r2: day_total_fit.r_squared(),
            emerald_slope_per_step: day_osmium_fit.slope_per_step(),
            emerald_r2: day_osmium_fit.r_squared(),
            tomato_slope_per_step: day_root_fit.slope_per_step(),
            tomato_r2: day_root_fit.r_squared(),
        });

        day_outputs.push(DayOutput {
            day,
            price_rows,
            trade_rows,
            trace_rows,
        });
    }

    let summary = SessionSummary {
        session_id,
        total_pnl: osmium_total + root_total,
        emerald_pnl: osmium_total,
        tomato_pnl: root_total,
        emerald_position: osmium_final_position,
        tomato_position: root_final_position,
        emerald_cash: osmium_cash_total,
        tomato_cash: root_cash_total,
        total_slope_per_step: total_fit.slope_per_step(),
        total_r2: total_fit.r_squared(),
        emerald_slope_per_step: osmium_fit.slope_per_step(),
        emerald_r2: osmium_fit.r_squared(),
        tomato_slope_per_step: root_fit.slope_per_step(),
        tomato_r2: root_fit.r_squared(),
    };

    Ok(SessionOutput {
        session_id,
        summary,
        run_summaries,
        day_outputs,
    })
}

fn write_backtest_outputs(config: &Config, outputs: &[SessionOutput]) -> Result<()> {
    fs::create_dir_all(&config.output_dir)?;
    let summary_path = config.output_dir.join("session_summary.csv");
    let mut writer = WriterBuilder::new()
        .delimiter(b',')
        .from_path(&summary_path)
        .with_context(|| format!("failed to open {}", summary_path.display()))?;
    for output in outputs {
        writer.serialize(&output.summary)?;
    }
    writer.flush()?;

    let run_summary_path = config.output_dir.join("run_summary.csv");
    let mut run_writer = WriterBuilder::new()
        .delimiter(b',')
        .from_path(&run_summary_path)
        .with_context(|| format!("failed to open {}", run_summary_path.display()))?;
    for output in outputs {
        for run_summary in &output.run_summaries {
            run_writer.serialize(run_summary)?;
        }
    }
    run_writer.flush()?;

    for output in outputs.iter().take(config.write_session_limit) {
        let round_dir = config
            .output_dir
            .join("sessions")
            .join(format!("session_{:05}", output.session_id))
            .join("round1");
        fs::create_dir_all(&round_dir)?;
        for day_output in &output.day_outputs {
            let price_path = round_dir.join(format!("prices_round_1_day_{}.csv", day_output.day));
            let trade_path = round_dir.join(format!("trades_round_1_day_{}.csv", day_output.day));
            let trace_path = round_dir.join(format!("trace_round_1_day_{}.csv", day_output.day));
            let mut price_writer = WriterBuilder::new().delimiter(b';').from_path(&price_path)?;
            for row in &day_output.price_rows {
                price_writer.serialize(row)?;
            }
            price_writer.flush()?;

            let mut trade_writer = WriterBuilder::new().delimiter(b';').from_path(&trade_path)?;
            for row in &day_output.trade_rows {
                trade_writer.serialize(row)?;
            }
            trade_writer.flush()?;

            let mut trace_writer = WriterBuilder::new().delimiter(b';').from_path(&trace_path)?;
            for row in &day_output.trace_rows {
                trace_writer.serialize(row)?;
            }
            trace_writer.flush()?;
        }
    }

    Ok(())
}

fn write_run_log(config: &Config) -> Result<()> {
    let log_path = config.output_dir.join("run.log");
    let contents = format!(
        "seed={}\nfv_mode={:?}\ntrade_mode={:?}\nosmium_phi={:.6}\nosmium_sigma={:.6}\nactual_dir={}\nstrategy={}\nsessions={}\nwrite_session_limit={}\n",
        config.seed,
        config.fv_mode,
        config.trade_mode,
        config.osmium_phi,
        config.osmium_sigma,
        config.actual_dir.display(),
        config
            .strategy_path
            .as_ref()
            .map(|path| path.display().to_string())
            .unwrap_or_else(|| "".to_string()),
        config.sessions,
        config.write_session_limit,
    );
    fs::create_dir_all(&config.output_dir)?;
    fs::write(&log_path, contents)
        .with_context(|| format!("failed to write {}", log_path.display()))?;
    Ok(())
}

fn seed_for_day(seed: u64, day: i32) -> u64 {
    let mut value = seed ^ (day as i64 as u64).wrapping_mul(0x9E37_79B9_7F4A_7C15);
    value ^= value >> 33;
    value = value.wrapping_mul(0xFF51_AFD7_ED55_8CCD);
    value ^= value >> 33;
    value
}

fn seed_for_session_day(seed: u64, session_id: usize, day: i32) -> u64 {
    seed_for_day(seed ^ ((session_id as u64).wrapping_mul(0xA24B_AED4_963E_E407)), day)
}

fn empty_trade_map() -> HashMap<String, Vec<Fill>> {
    HashMap::from([
        (OSMIUM_PRODUCT.to_string(), Vec::new()),
        (ROOT_PRODUCT.to_string(), Vec::new()),
    ])
}

fn fills_to_worker_trade_map(source: &HashMap<String, Vec<Fill>>) -> HashMap<String, Vec<WorkerTrade>> {
    PRODUCTS
        .iter()
        .map(|product| {
            let trades = source
                .get(*product)
                .cloned()
                .unwrap_or_default()
                .into_iter()
                .map(|fill| WorkerTrade {
                    symbol: fill.symbol,
                    price: fill.price,
                    quantity: fill.quantity,
                    buyer: fill.buyer,
                    seller: fill.seller,
                    timestamp: fill.timestamp,
                })
                .collect::<Vec<_>>();
            ((*product).to_string(), trades)
        })
        .collect()
}

fn book_to_worker_depth(book: &Book) -> WorkerOrderDepth {
    let buy_orders = book
        .bids
        .iter()
        .map(|(price, qty)| (price.to_string(), *qty))
        .collect::<HashMap<_, _>>();
    let sell_orders = book
        .asks
        .iter()
        .map(|(price, qty)| (price.to_string(), -*qty))
        .collect::<HashMap<_, _>>();
    WorkerOrderDepth {
        buy_orders,
        sell_orders,
    }
}

fn book_to_sim_book(book: &Book) -> SimBook {
    SimBook {
        bids: book
            .bids
            .iter()
            .map(|(price, quantity)| Level {
                price: *price,
                quantity: *quantity,
                owner: LevelOwner::Bot,
            })
            .collect(),
        asks: book
            .asks
            .iter()
            .map(|(price, quantity)| Level {
                price: *price,
                quantity: *quantity,
                owner: LevelOwner::Bot,
            })
            .collect(),
    }
}

fn normalize_strategy_orders(
    raw: HashMap<String, Vec<WorkerOrder>>,
) -> HashMap<String, Vec<WorkerOrder>> {
    PRODUCTS
        .iter()
        .map(|product| {
            (
                (*product).to_string(),
                raw.get(*product).cloned().unwrap_or_default(),
            )
        })
        .collect()
}

fn enforce_strategy_limits(
    orders: &HashMap<String, Vec<WorkerOrder>>,
    ledgers: &HashMap<String, ProductLedger>,
) -> HashMap<String, Vec<WorkerOrder>> {
    orders
        .iter()
        .map(|(product, product_orders)| {
            let current_position = ledgers.get(product).map(|ledger| ledger.position).unwrap_or(0);
            let total_buy: i32 = product_orders
                .iter()
                .filter(|order| order.quantity > 0)
                .map(|order| order.quantity)
                .sum();
            let total_sell: i32 = product_orders
                .iter()
                .filter(|order| order.quantity < 0)
                .map(|order| -order.quantity)
                .sum();

            let accepted = if current_position + total_buy > POSITION_LIMIT
                || current_position - total_sell < -POSITION_LIMIT
            {
                Vec::new()
            } else {
                product_orders.clone()
            };

            (product.clone(), accepted)
        })
        .collect()
}

fn execute_strategy_orders(
    product: &str,
    timestamp: i32,
    book: &mut SimBook,
    ledger: &mut ProductLedger,
    orders: &[WorkerOrder],
) -> Vec<Fill> {
    let mut fills = Vec::new();
    let mut passive_bids: HashMap<i32, i32> = HashMap::new();
    let mut passive_asks: HashMap<i32, i32> = HashMap::new();

    for order in orders {
        if order.quantity > 0 {
            let mut remaining = order.quantity;
            while remaining > 0 {
                let Some(best_ask) = book.asks.first_mut() else {
                    break;
                };
                if best_ask.owner != LevelOwner::Bot || best_ask.price > order.price {
                    break;
                }
                let fill_qty = remaining.min(best_ask.quantity);
                fills.push(Fill {
                    symbol: product.to_string(),
                    price: best_ask.price,
                    quantity: fill_qty,
                    buyer: Some("SUBMISSION".to_string()),
                    seller: Some("BOT".to_string()),
                    timestamp,
                });
                ledger.position += fill_qty;
                ledger.cash -= best_ask.price as f64 * fill_qty as f64;
                remaining -= fill_qty;
                best_ask.quantity -= fill_qty;
                if best_ask.quantity == 0 {
                    book.asks.remove(0);
                }
            }
            if remaining > 0 {
                *passive_bids.entry(order.price).or_insert(0) += remaining;
            }
        } else if order.quantity < 0 {
            let mut remaining = -order.quantity;
            while remaining > 0 {
                let Some(best_bid) = book.bids.first_mut() else {
                    break;
                };
                if best_bid.owner != LevelOwner::Bot || best_bid.price < order.price {
                    break;
                }
                let fill_qty = remaining.min(best_bid.quantity);
                fills.push(Fill {
                    symbol: product.to_string(),
                    price: best_bid.price,
                    quantity: fill_qty,
                    buyer: Some("BOT".to_string()),
                    seller: Some("SUBMISSION".to_string()),
                    timestamp,
                });
                ledger.position -= fill_qty;
                ledger.cash += best_bid.price as f64 * fill_qty as f64;
                remaining -= fill_qty;
                best_bid.quantity -= fill_qty;
                if best_bid.quantity == 0 {
                    book.bids.remove(0);
                }
            }
            if remaining > 0 {
                *passive_asks.entry(order.price).or_insert(0) += remaining;
            }
        }
    }

    for (price, quantity) in passive_bids {
        insert_level(
            &mut book.bids,
            Level {
                price,
                quantity,
                owner: LevelOwner::Strategy,
            },
            true,
        );
    }
    for (price, quantity) in passive_asks {
        insert_level(
            &mut book.asks,
            Level {
                price,
                quantity,
                owner: LevelOwner::Strategy,
            },
            false,
        );
    }

    fills
}

fn execute_taker_trade(
    product: &str,
    timestamp: i32,
    book: &mut SimBook,
    ledger: &mut ProductLedger,
    market_buy: bool,
    rng: &mut ChaCha8Rng,
) -> Vec<Fill> {
    let mut fills = Vec::new();
    let available_volume = if market_buy {
        book.asks.iter().map(|level| level.quantity).sum()
    } else {
        book.bids.iter().map(|level| level.quantity).sum()
    };
    if available_volume <= 0 {
        return fills;
    }

    let mut remaining = sample_trade_quantity_by_side(product, market_buy, available_volume, rng);

    while remaining > 0 {
        let (price, owner, fill_qty) = if market_buy {
            let Some(best_ask) = book.asks.first_mut() else {
                break;
            };
            let fill_qty = remaining.min(best_ask.quantity);
            let price = best_ask.price;
            let owner = best_ask.owner;
            best_ask.quantity -= fill_qty;
            if best_ask.quantity == 0 {
                book.asks.remove(0);
            }
            (price, owner, fill_qty)
        } else {
            let Some(best_bid) = book.bids.first_mut() else {
                break;
            };
            let fill_qty = remaining.min(best_bid.quantity);
            let price = best_bid.price;
            let owner = best_bid.owner;
            best_bid.quantity -= fill_qty;
            if best_bid.quantity == 0 {
                book.bids.remove(0);
            }
            (price, owner, fill_qty)
        };

        if fill_qty <= 0 {
            break;
        }

        let fill = match (market_buy, owner) {
            (true, LevelOwner::Bot) => Fill {
                symbol: product.to_string(),
                price,
                quantity: fill_qty,
                buyer: Some("BOT_TAKER".to_string()),
                seller: Some("BOT_MAKER".to_string()),
                timestamp,
            },
            (true, LevelOwner::Strategy) => {
                ledger.position -= fill_qty;
                ledger.cash += price as f64 * fill_qty as f64;
                Fill {
                    symbol: product.to_string(),
                    price,
                    quantity: fill_qty,
                    buyer: Some("BOT_TAKER".to_string()),
                    seller: Some("SUBMISSION".to_string()),
                    timestamp,
                }
            }
            (false, LevelOwner::Bot) => Fill {
                symbol: product.to_string(),
                price,
                quantity: fill_qty,
                buyer: Some("BOT_MAKER".to_string()),
                seller: Some("BOT_TAKER".to_string()),
                timestamp,
            },
            (false, LevelOwner::Strategy) => {
                ledger.position += fill_qty;
                ledger.cash -= price as f64 * fill_qty as f64;
                Fill {
                    symbol: product.to_string(),
                    price,
                    quantity: fill_qty,
                    buyer: Some("SUBMISSION".to_string()),
                    seller: Some("BOT_TAKER".to_string()),
                    timestamp,
                }
            }
        };
        fills.push(fill);
        remaining -= fill_qty;
    }

    fills
}

fn insert_level(levels: &mut Vec<Level>, level: Level, descending: bool) {
    if let Some(existing) = levels
        .iter_mut()
        .find(|existing| existing.price == level.price && existing.owner == level.owner)
    {
        existing.quantity += level.quantity;
    } else {
        levels.push(level);
    }
    if descending {
        levels.sort_by(|a, b| b.price.cmp(&a.price).then(owner_priority(a.owner).cmp(&owner_priority(b.owner))));
    } else {
        levels.sort_by(|a, b| a.price.cmp(&b.price).then(owner_priority(a.owner).cmp(&owner_priority(b.owner))));
    }
}

fn owner_priority(owner: LevelOwner) -> i32 {
    match owner {
        LevelOwner::Bot => 0,
        LevelOwner::Strategy => 1,
    }
}

fn fill_involves_strategy(fill: &Fill) -> bool {
    fill.buyer.as_deref() == Some("SUBMISSION") || fill.seller.as_deref() == Some("SUBMISSION")
}

fn fill_to_trade_row(fill: &Fill) -> TradeRow {
    TradeRow {
        timestamp: fill.timestamp,
        buyer: fill.buyer.clone(),
        seller: fill.seller.clone(),
        symbol: fill.symbol.clone(),
        currency: "XIRECS".to_string(),
        price: fill.price as f64,
        quantity: fill.quantity,
    }
}

fn sample_trade_side(product: &str, rng: &mut ChaCha8Rng) -> bool {
    let buy_prob = if product == OSMIUM_PRODUCT {
        OSMIUM_TRADE_BUY_PROB
    } else {
        ROOT_TRADE_BUY_PROB
    };
    rng.gen_bool(buy_prob)
}

fn load_price_rows(actual_dir: &Path, day: i32) -> Result<Vec<InputPriceRow>> {
    let path = actual_dir.join(format!("prices_round_1_day_{}.csv", day));
    let mut reader = ReaderBuilder::new()
        .delimiter(b';')
        .from_path(&path)
        .with_context(|| format!("failed to read {}", path.display()))?;
    let mut rows = Vec::new();
    for record in reader.deserialize() {
        let row: InputPriceRow = record?;
        rows.push(row);
    }
    Ok(rows)
}

fn load_trade_rows(actual_dir: &Path, day: i32) -> Result<Vec<InputTradeRow>> {
    let path = actual_dir.join(format!("trades_round_1_day_{}.csv", day));
    let mut reader = ReaderBuilder::new()
        .delimiter(b';')
        .from_path(&path)
        .with_context(|| format!("failed to read {}", path.display()))?;
    let mut rows = Vec::new();
    for record in reader.deserialize() {
        let row: InputTradeRow = record?;
        rows.push(row);
    }
    Ok(rows)
}

fn infer_observed_fair(row: &InputPriceRow) -> f64 {
    let bids = [row.bid_price_1, row.bid_price_2, row.bid_price_3]
        .into_iter()
        .flatten()
        .collect::<Vec<_>>();
    let asks = [row.ask_price_1, row.ask_price_2, row.ask_price_3]
        .into_iter()
        .flatten()
        .collect::<Vec<_>>();
    let worst_bid = bids.into_iter().min().unwrap_or(0);
    let worst_ask = asks.into_iter().max().unwrap_or(0);
    (worst_bid as f64 + worst_ask as f64) / 2.0
}

fn estimate_osmium_replay_fair(row: &InputPriceRow) -> f64 {
    let bid_levels = [row.bid_price_1.zip(row.bid_volume_1), row.bid_price_2.zip(row.bid_volume_2), row.bid_price_3.zip(row.bid_volume_3)]
        .into_iter()
        .flatten()
        .collect::<Vec<_>>();
    let ask_levels = [row.ask_price_1.zip(row.ask_volume_1), row.ask_price_2.zip(row.ask_volume_2), row.ask_price_3.zip(row.ask_volume_3)]
        .into_iter()
        .flatten()
        .collect::<Vec<_>>();

    let mut best: Option<((f64, i32), f64)> = None;
    for bid_inner in 0..=bid_levels.len() {
        for bid_outer in 0..=bid_levels.len() {
            let bid_inner = if bid_inner == bid_levels.len() { None } else { Some(bid_inner) };
            let bid_outer = if bid_outer == bid_levels.len() { None } else { Some(bid_outer) };
            if bid_inner.is_some() && bid_inner == bid_outer {
                continue;
            }
            if let Some(index) = bid_inner {
                let (_, volume) = bid_levels[index];
                if !(10..=15).contains(&volume) {
                    continue;
                }
            }
            if let Some(index) = bid_outer {
                let (_, volume) = bid_levels[index];
                if !(20..=30).contains(&volume) {
                    continue;
                }
            }
            if let (Some(inner), Some(outer)) = (bid_inner, bid_outer) {
                if bid_levels[inner].0 <= bid_levels[outer].0 {
                    continue;
                }
            }

            for ask_inner in 0..=ask_levels.len() {
                for ask_outer in 0..=ask_levels.len() {
                    let ask_inner = if ask_inner == ask_levels.len() { None } else { Some(ask_inner) };
                    let ask_outer = if ask_outer == ask_levels.len() { None } else { Some(ask_outer) };
                    if ask_inner.is_some() && ask_inner == ask_outer {
                        continue;
                    }
                    if let Some(index) = ask_inner {
                        let (_, volume) = ask_levels[index];
                        if !(10..=15).contains(&volume) {
                            continue;
                        }
                    }
                    if let Some(index) = ask_outer {
                        let (_, volume) = ask_levels[index];
                        if !(20..=30).contains(&volume) {
                            continue;
                        }
                    }
                    if let (Some(inner), Some(outer)) = (ask_inner, ask_outer) {
                        if ask_levels[inner].0 >= ask_levels[outer].0 {
                            continue;
                        }
                    }

                    let mut lower = f64::NEG_INFINITY;
                    let mut upper = f64::INFINITY;
                    let mut used = 0;

                    if let Some(index) = bid_inner {
                        let (price, _) = bid_levels[index];
                        lower = lower.max(price as f64 + 7.5);
                        upper = upper.min(price as f64 + 8.5);
                        used += 1;
                    }
                    if let Some(index) = bid_outer {
                        let (price, _) = bid_levels[index];
                        lower = lower.max(price as f64 + 10.0);
                        upper = upper.min(price as f64 + 11.0);
                        used += 1;
                    }
                    if let Some(index) = ask_inner {
                        let (price, _) = ask_levels[index];
                        lower = lower.max(price as f64 - 8.5);
                        upper = upper.min(price as f64 - 7.5);
                        used += 1;
                    }
                    if let Some(index) = ask_outer {
                        let (price, _) = ask_levels[index];
                        lower = lower.max(price as f64 - 11.0);
                        upper = upper.min(price as f64 - 10.0);
                        used += 1;
                    }

                    if used < 2 || lower >= upper {
                        continue;
                    }

                    let width = upper - lower;
                    let midpoint = 0.5 * (lower + upper);
                    let score = (width, -used);
                    match best {
                        None => best = Some((score, midpoint)),
                        Some((current_score, _)) if score < current_score => {
                            best = Some((score, midpoint));
                        }
                        _ => {}
                    }
                }
            }
        }
    }

    best.map(|(_, midpoint)| midpoint).unwrap_or_else(|| infer_observed_fair(row))
}

fn root_fair_for_timestamp(day: i32, timestamp: i32) -> f64 {
    ((ROOT_BASE_MU + ROOT_DAY_STRIDE * day as f64 + timestamp as f64 / 1000.0) as f32) as f64
}

fn osmium_start_for_day(day: i32) -> f64 {
    match day {
        -2 => 10000.25,
        -1 => 9992.25,
        0 => 10002.75,
        _ => OSMIUM_MU,
    }
}

fn simulate_osmium_fair(
    day: i32,
    ticks: usize,
    phi: f64,
    sigma: f64,
    rng: &mut ChaCha8Rng,
) -> Vec<f64> {
    let mut fair = vec![0.0; ticks];
    if ticks == 0 {
        return fair;
    }
    fair[0] = ((osmium_start_for_day(day)) as f32) as f64;
    for index in 1..ticks {
        let shock = sigma * sample_standard_normal(rng);
        let next = OSMIUM_MU + phi * (fair[index - 1] - OSMIUM_MU) + shock;
        fair[index] = (next as f32) as f64;
    }
    fair
}

fn estimate_tomato_latent_state(row: &InputPriceRow) -> TomatoLatentState {
    let Some((inner_bid, outer_bid, inner_ask, outer_ask)) = tomato_wall_quotes(row) else {
        return TomatoLatentState {
            fair: infer_observed_fair(row),
            half_tie_orientation: HalfTieOrientation::Inward,
        };
    };

    let intervals = [
        interval_from_quote(outer_bid, -8.0),
        interval_from_quote(outer_ask, 8.0),
        interval_from_quote(inner_bid, -6.5),
        interval_from_quote(inner_ask, 6.5),
    ];

    let lower = intervals
        .iter()
        .map(|(lo, _)| *lo)
        .fold(f64::NEG_INFINITY, f64::max);
    let upper = intervals
        .iter()
        .map(|(_, hi)| *hi)
        .fold(f64::INFINITY, f64::min);

    let fair = if lower <= upper {
        (lower + upper) / 2.0
    } else {
        (outer_bid as f64 + outer_ask as f64) / 2.0
    };
    let half_tie_orientation = match outer_ask - outer_bid {
        15 => HalfTieOrientation::Inward,
        17 => HalfTieOrientation::Outward,
        _ => HalfTieOrientation::Inward,
    };

    TomatoLatentState {
        fair,
        half_tie_orientation,
    }
}

fn tomato_wall_quotes(row: &InputPriceRow) -> Option<(i32, i32, i32, i32)> {
    let bid3 = row.bid_price_3.is_some();
    let ask3 = row.ask_price_3.is_some();

    match (bid3, ask3) {
        (false, false) => Some((
            row.bid_price_1?,
            row.bid_price_2?,
            row.ask_price_1?,
            row.ask_price_2?,
        )),
        (true, false) => Some((
            row.bid_price_2?,
            row.bid_price_3?,
            row.ask_price_1?,
            row.ask_price_2?,
        )),
        (false, true) => Some((
            row.bid_price_1?,
            row.bid_price_2?,
            row.ask_price_2?,
            row.ask_price_3?,
        )),
        (true, true) => None,
    }
}

fn interval_from_quote(price: i32, offset: f64) -> (f64, f64) {
    (
        price as f64 - 0.5 - offset,
        price as f64 + 0.5 - offset,
    )
}

fn trade_counts_for(
    product: &str,
    day: i32,
    config: &Config,
    replay: &ReplayData,
    rng: &mut ChaCha8Rng,
) -> Result<Vec<usize>> {
    match config.trade_mode {
        TradeMode::ReplayTimes => replay
            .trade_counts_by_key
            .get(&(day, product.to_string()))
            .cloned()
            .context("missing replay trade count series"),
        TradeMode::Simulate => Ok(simulate_trade_counts(product, config.ticks_per_day, rng)),
    }
}

fn simulate_trade_counts(product: &str, ticks: usize, rng: &mut ChaCha8Rng) -> Vec<usize> {
    let base_prob = if product == OSMIUM_PRODUCT {
        OSMIUM_TRADE_ACTIVE_PROB
    } else {
        ROOT_TRADE_ACTIVE_PROB
    };
    let second_trade_prob = if product == OSMIUM_PRODUCT {
        OSMIUM_SECOND_TRADE_PROB
    } else if product == ROOT_PRODUCT {
        ROOT_SECOND_TRADE_PROB
    } else {
        0.0
    };
    let mut counts = vec![0usize; ticks];
    for count in &mut counts {
        if rng.gen_bool(base_prob) {
            *count = 1;
            if second_trade_prob > 0.0 && rng.gen_bool(second_trade_prob) {
                *count += 1;
            }
        }
    }
    counts
}

fn simulate_tomato_fair(
    day: i32,
    support: TomatoSupport,
    ticks: usize,
    rng: &mut ChaCha8Rng,
) -> Vec<TomatoLatentState> {
    let start = if day == -1 { 5006.0 } else { 5000.0 };
    let sigma = 0.496;
    let mut states = vec![
        TomatoLatentState {
            fair: 0.0,
            half_tie_orientation: HalfTieOrientation::Inward,
        };
        ticks
    ];
    let mut orientation = if rng.gen_bool(0.5) {
        HalfTieOrientation::Inward
    } else {
        HalfTieOrientation::Outward
    };
    states[0] = TomatoLatentState {
        fair: quantize_tomato_fair(start, support),
        half_tie_orientation: orientation,
    };

    for index in 1..ticks {
        let step = sigma * sample_standard_normal(rng);
        if rng.gen_bool(TOMATO_HALF_TIE_FLIP_PROB) {
            orientation = orientation.flip();
        }
        states[index] = TomatoLatentState {
            fair: quantize_tomato_fair(states[index - 1].fair + step, support),
            half_tie_orientation: orientation,
        };
    }

    states
}

fn quantize_tomato_fair(value: f64, support: TomatoSupport) -> f64 {
    match support {
        TomatoSupport::Continuous => value,
        TomatoSupport::Half => (value * 2.0).round() / 2.0,
        TomatoSupport::Quarter => (value * 4.0).round() / 4.0,
    }
}

fn sample_standard_normal(rng: &mut ChaCha8Rng) -> f64 {
    let u1 = rng.gen_range(f64::EPSILON..1.0);
    let u2 = rng.gen_range(0.0..1.0);
    (-2.0 * u1.ln()).sqrt() * (2.0 * std::f64::consts::PI * u2).cos()
}

fn sample_visibility_mask(
    masks: &[(bool, bool, bool, bool)],
    weights: &[u32],
    rng: &mut ChaCha8Rng,
) -> (bool, bool, bool, bool) {
    let chooser = WeightedIndex::new(weights).expect("valid visibility mask weights");
    masks[chooser.sample(rng)]
}

fn add_book_level(levels: &mut Vec<(i32, i32)>, price: i32, quantity: i32, descending: bool) {
    if quantity <= 0 {
        return;
    }
    if let Some(existing) = levels.iter_mut().find(|(existing_price, _)| *existing_price == price) {
        existing.1 += quantity;
    } else {
        levels.push((price, quantity));
    }
    if descending {
        levels.sort_by(|a, b| b.0.cmp(&a.0));
    } else {
        levels.sort_by(|a, b| a.0.cmp(&b.0));
    }
}

fn make_osmium_book(fair: f64, rng: &mut ChaCha8Rng) -> Book {
    let mut bids = Vec::new();
    let mut asks = Vec::new();
    let outer_size = rng.gen_range(20..=30);
    let inner_size = rng.gen_range(10..=15);
    let outer_bid = fair.floor() as i32 - 10;
    let outer_ask = fair.ceil() as i32 + 10;
    let inner_anchor = round_nearest(fair);
    let inner_bid = inner_anchor - 8;
    let inner_ask = inner_anchor + 8;
    let mask = sample_visibility_mask(&OSMIUM_MASKS, &OSMIUM_MASK_WEIGHTS, rng);

    if mask.1 {
        add_book_level(&mut bids, outer_bid, outer_size, true);
    }
    if mask.0 {
        add_book_level(&mut bids, inner_bid, inner_size, true);
    }
    if mask.2 {
        add_book_level(&mut asks, inner_ask, inner_size, false);
    }
    if mask.3 {
        add_book_level(&mut asks, outer_ask, outer_size, false);
    }

    if rng.gen_bool(OSMIUM_NEAR_BOT_PROB) {
        let side_bid = rng.gen_bool(0.5);
        let aggressive = rng.gen_bool(0.5);
        let base = fair.floor() as i32;
        if side_bid {
            let price = if aggressive { base + 2 } else { base - 2 };
            let quantity = if aggressive {
                rng.gen_range(4..=10)
            } else {
                rng.gen_range(1..=5)
            };
            add_book_level(&mut bids, price, quantity, true);
        } else {
            let price = if aggressive { base - 2 } else { base + 2 };
            let quantity = if aggressive {
                rng.gen_range(4..=10)
            } else {
                rng.gen_range(2..=5)
            };
            add_book_level(&mut asks, price, quantity, false);
        }
    }

    Book { bids, asks }
}

fn make_root_book(day: i32, timestamp: i32, rng: &mut ChaCha8Rng) -> Book {
    let fair = root_fair_for_timestamp(day, timestamp);
    let mut bids = Vec::new();
    let mut asks = Vec::new();
    let outer_size = rng.gen_range(15..=25);
    let inner_size = rng.gen_range(8..=12);
    let outer_bid = fair.ceil() as i32 - 10;
    let outer_ask = fair.floor() as i32 + 10;
    let inner_bid = fair.ceil() as i32 - 7;
    let inner_ask = fair.floor() as i32 + 7;
    let mask = sample_visibility_mask(&ROOT_MASKS, &ROOT_MASK_WEIGHTS, rng);

    if mask.1 {
        add_book_level(&mut bids, outer_bid, outer_size, true);
    }
    if mask.0 {
        add_book_level(&mut bids, inner_bid, inner_size, true);
    }
    if mask.2 {
        add_book_level(&mut asks, inner_ask, inner_size, false);
    }
    if mask.3 {
        add_book_level(&mut asks, outer_ask, outer_size, false);
    }

    if rng.gen_bool(ROOT_NEAR_BOT_PROB) {
        let rounded = round_nearest(fair);
        let side_bid = rng.gen_bool(21.0 / 45.0);
        if side_bid {
            let aggressive = rng.gen_bool(13.0 / 21.0);
            let price = if aggressive {
                if rng.gen_bool(2.0 / 13.0) { rounded + 4 } else { rounded + 3 }
            } else {
                rounded - 3
            };
            let quantity = if aggressive {
                rng.gen_range(3..=8)
            } else {
                rng.gen_range(5..=12)
            };
            add_book_level(&mut bids, price, quantity, true);
        } else {
            let aggressive = rng.gen_bool(13.0 / 24.0);
            let price = if aggressive { rounded - 4 } else { rounded + 2 };
            let quantity = if aggressive {
                rng.gen_range(3..=8)
            } else {
                rng.gen_range(5..=12)
            };
            add_book_level(&mut asks, price, quantity, false);
        }
    }

    Book { bids, asks }
}

fn make_emerald_book(rng: &mut ChaCha8Rng) -> Book {
    let fair = 10_000;
    let inner_size = rng.gen_range(10..=15);
    let outer_size = rng.gen_range(20..=30);
    let draw: f64 = rng.gen_range(0.0..1.0);

    if draw < 321.0 / 20_000.0 {
        let bot3_size = rng.gen_range(5..=10);
        Book {
            bids: vec![
                (fair, bot3_size),
                (fair - 8, inner_size),
                (fair - 10, outer_size),
            ],
            asks: vec![(fair + 8, inner_size), (fair + 10, outer_size)],
        }
    } else if draw < (321.0 + 333.0) / 20_000.0 {
        let bot3_size = rng.gen_range(5..=10);
        Book {
            bids: vec![(fair - 8, inner_size), (fair - 10, outer_size)],
            asks: vec![
                (fair, bot3_size),
                (fair + 8, inner_size),
                (fair + 10, outer_size),
            ],
        }
    } else {
        Book {
            bids: vec![(fair - 8, inner_size), (fair - 10, outer_size)],
            asks: vec![(fair + 8, inner_size), (fair + 10, outer_size)],
        }
    }
}

fn make_tomato_book(latent_state: TomatoLatentState, rng: &mut ChaCha8Rng) -> Book {
    let outer_size = rng.gen_range(15..=25);
    let inner_size = rng.gen_range(5..=10);
    let (outer_bid, outer_ask) = tomato_outer_quotes(latent_state);
    let (inner_bid, inner_ask) = tomato_inner_quotes(latent_state.fair);
    let draw: f64 = rng.gen_range(0.0..1.0);

    // Bot 3: 6.3% presence, 50/50 bid/ask
    if draw < 0.063 / 2.0 {
        let (bot3_price, bot3_size) = tomato_bot3_bid_quote(latent_state.fair, rng);
        Book {
            bids: vec![
                (bot3_price, bot3_size),
                (inner_bid, inner_size),
                (outer_bid, outer_size),
            ],
            asks: vec![(inner_ask, inner_size), (outer_ask, outer_size)],
        }
    } else if draw < 0.063 {
        let (bot3_price, bot3_size) = tomato_bot3_ask_quote(latent_state.fair, rng);
        Book {
            bids: vec![(inner_bid, inner_size), (outer_bid, outer_size)],
            asks: vec![
                (bot3_price, bot3_size),
                (inner_ask, inner_size),
                (outer_ask, outer_size),
            ],
        }
    } else {
        Book {
            bids: vec![(inner_bid, inner_size), (outer_bid, outer_size)],
            asks: vec![(inner_ask, inner_size), (outer_ask, outer_size)],
        }
    }
}

fn tomato_outer_quotes(latent_state: TomatoLatentState) -> (i32, i32) {
    let bid_target = latent_state.fair - 8.0;
    let ask_target = latent_state.fair + 8.0;

    if is_half_tie(bid_target) && is_half_tie(ask_target) {
        // Bot 1 is deterministic once the latent half-tie orientation bit is
        // part of the shared fair state. Bot 2 ignores this bit because its
        // +/-6.5 targets on half-mid rows land on exact integers.
        match latent_state.half_tie_orientation {
            HalfTieOrientation::Inward => (round_up(bid_target), round_down(ask_target)),
            HalfTieOrientation::Outward => (round_down(bid_target), round_up(ask_target)),
        }
    } else {
        (round_nearest(bid_target), round_nearest(ask_target))
    }
}

fn tomato_inner_quotes(latent_fair: f64) -> (i32, i32) {
    // Calibrated: bid rounds at frac=0.25, ask rounds at frac=0.75
    // bid = floor(FV + 0.75) - 7
    // ask = ceil(FV + 0.25) + 6
    let bid = (latent_fair + 0.75).floor() as i32 - 7;
    let ask = (latent_fair + 0.25).ceil() as i32 + 6;
    (bid, ask)
}

fn tomato_bot3_bid_quote(latent_fair: f64, rng: &mut ChaCha8Rng) -> (i32, i32) {
    // 2/3 passive (offset -2 or -1), 1/3 aggressive (offset 0 or +1)
    // 50/50 within each group
    let passive = rng.gen_bool(2.0 / 3.0);
    let near = rng.gen_bool(0.5);
    let offset = if passive {
        if near { -1 } else { -2 }
    } else {
        if near { 0 } else { 1 }
    };
    let price = round_nearest(latent_fair) + offset;
    let size = if passive {
        rng.gen_range(2..=6)
    } else {
        rng.gen_range(5..=12)
    };
    (price, size)
}

fn tomato_bot3_ask_quote(latent_fair: f64, rng: &mut ChaCha8Rng) -> (i32, i32) {
    // 2/3 passive (offset 0 or +1), 1/3 aggressive (offset -2 or -1)
    // 50/50 within each group
    let passive = rng.gen_bool(2.0 / 3.0);
    let near = rng.gen_bool(0.5);
    let offset = if passive {
        if near { 0 } else { 1 }
    } else {
        if near { -1 } else { -2 }
    };
    let price = round_nearest(latent_fair) + offset;
    let size = if passive {
        rng.gen_range(2..=6)
    } else {
        rng.gen_range(5..=12)
    };
    (price, size)
}

fn round_nearest(value: f64) -> i32 {
    value.round() as i32
}

fn round_down(value: f64) -> i32 {
    value.floor() as i32
}

fn round_up(value: f64) -> i32 {
    value.ceil() as i32
}

fn is_half_tie(value: f64) -> bool {
    ((value.fract().abs()) - 0.5).abs() < 1e-9
}

fn book_to_price_row(day: i32, timestamp: i32, product: &str, book: &Book) -> PriceRow {
    let bid1 = book.bids.first().copied();
    let bid2 = book.bids.get(1).copied();
    let bid3 = book.bids.get(2).copied();
    let ask1 = book.asks.first().copied();
    let ask2 = book.asks.get(1).copied();
    let ask3 = book.asks.get(2).copied();
    let mid_price = match (bid1, ask1) {
        (Some(bid), Some(ask)) => (bid.0 as f64 + ask.0 as f64) / 2.0,
        (Some(bid), None) => bid.0 as f64,
        (None, Some(ask)) => ask.0 as f64,
        (None, None) => 0.0,
    };

    PriceRow {
        day,
        timestamp,
        product: product.to_string(),
        bid_price_1: bid1.map(|x| x.0),
        bid_volume_1: bid1.map(|x| x.1),
        bid_price_2: bid2.map(|x| x.0),
        bid_volume_2: bid2.map(|x| x.1),
        bid_price_3: bid3.map(|x| x.0),
        bid_volume_3: bid3.map(|x| x.1),
        ask_price_1: ask1.map(|x| x.0),
        ask_volume_1: ask1.map(|x| x.1),
        ask_price_2: ask2.map(|x| x.0),
        ask_volume_2: ask2.map(|x| x.1),
        ask_price_3: ask3.map(|x| x.0),
        ask_volume_3: ask3.map(|x| x.1),
        mid_price,
        profit_and_loss: 0.0,
    }
}

fn sample_trade_rows(timestamp: i32, product: &str, book: &Book, rng: &mut ChaCha8Rng) -> Vec<TradeRow> {
    let market_buy = sample_trade_side(product, rng);
    let available_volume: i32 = if market_buy {
        book.asks.iter().map(|(_, volume)| *volume).sum()
    } else {
        book.bids.iter().map(|(_, volume)| *volume).sum()
    };
    if available_volume <= 0 {
        return Vec::new();
    }

    let quantity = sample_trade_quantity_by_side(product, market_buy, available_volume, rng);

    let mut rows = Vec::new();
    let mut remaining = quantity;
    if market_buy {
        for (price, volume_limit) in &book.asks {
            if remaining <= 0 {
                break;
            }
            let fill_qty = remaining.min(*volume_limit);
            rows.push(TradeRow {
                timestamp,
                buyer: None,
                seller: None,
                symbol: product.to_string(),
                currency: "XIRECS".to_string(),
                price: *price as f64,
                quantity: fill_qty,
            });
            remaining -= fill_qty;
        }
    } else {
        for (price, volume_limit) in &book.bids {
            if remaining <= 0 {
                break;
            }
            let fill_qty = remaining.min(*volume_limit);
            rows.push(TradeRow {
                timestamp,
                buyer: None,
                seller: None,
                symbol: product.to_string(),
                currency: "XIRECS".to_string(),
                price: *price as f64,
                quantity: fill_qty,
            });
            remaining -= fill_qty;
        }
    }

    rows
}

fn sample_trade_quantity_by_side(
    product: &str,
    market_buy: bool,
    volume_limit: i32,
    rng: &mut ChaCha8Rng,
) -> i32 {
    let (values, weights): (&[i32], &[u32]) = match (product, market_buy) {
        (OSMIUM_PRODUCT, true) => (&[2, 3, 4, 5, 6, 7, 8, 9, 10], &[78, 82, 96, 131, 110, 42, 36, 32, 40]),
        (OSMIUM_PRODUCT, false) => (&[2, 3, 4, 5, 6, 7, 8, 9, 10], &[82, 97, 76, 93, 120, 36, 35, 44, 35]),
        (ROOT_PRODUCT, true) => (&[2, 3, 4, 5, 6, 7, 8], &[1, 98, 75, 95, 104, 91, 29]),
        (ROOT_PRODUCT, false) => (&[3, 4, 5, 6, 7, 8], &[100, 86, 100, 115, 104, 13]),
        _ => (&[1], &[1]),
    };

    let filtered = values
        .iter()
        .zip(weights.iter())
        .filter(|(value, _)| **value <= volume_limit)
        .map(|(value, weight)| (*value, *weight))
        .collect::<Vec<_>>();

    if filtered.is_empty() {
        return volume_limit.max(1);
    }

    let filtered_values = filtered.iter().map(|(value, _)| *value).collect::<Vec<_>>();
    let filtered_weights = filtered
        .iter()
        .map(|(_, weight)| *weight)
        .collect::<Vec<_>>();
    let chooser = WeightedIndex::new(filtered_weights).expect("valid filtered trade weights");
    filtered_values[chooser.sample(rng)]
}
