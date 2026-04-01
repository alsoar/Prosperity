import { Badge, Box, Button, Container, Group, Text } from '@mantine/core';
import { IconChartDots } from '@tabler/icons-react';
import { ReactNode } from 'react';
import { NavLink, useLocation } from 'react-router-dom';
import classes from './Header.module.css';

export function Header(): ReactNode {
  const { pathname } = useLocation();
  const isArchetypesPage = pathname.includes('/round-1-archetypes');
  const isStrategyPage = pathname.includes('/strategy-viewer') || pathname.includes('/visualizer');

  const subtitle = isArchetypesPage
    ? 'Prosperity 3 Round 1 latent actor board'
    : isStrategyPage
    ? 'Upload and inspect Prosperity strategy logs'
    : 'Hedgehogs-style tutorial market dashboard';

  const badges = isArchetypesPage
    ? [
        { label: 'Archetypes', color: 'brass' },
        { label: 'Conviction', color: 'marketBlue' },
        { label: 'Natural Language', color: 'marketRed' },
      ]
    : isStrategyPage
    ? [
        { label: 'Strategy Logs', color: 'brass' },
        { label: 'PnL', color: 'marketBlue' },
        { label: 'Orders', color: 'marketRed' },
      ]
    : [
        { label: 'Order Book', color: 'brass' },
        { label: 'Trades', color: 'marketBlue' },
        { label: 'Flow Proxy', color: 'marketRed' },
      ];

  return (
    <header className={classes.header}>
      <Container fluid className={classes.inner}>
        <Group gap="md">
          <Box className={classes.brandMark}>
            <IconChartDots size={22} />
          </Box>
          <Box>
            <Text className={classes.title}>Prosperity Desk</Text>
            <Text className={classes.subtitle}>{subtitle}</Text>
          </Box>
        </Group>

        <Group gap="sm" wrap="nowrap">
          <Group gap="xs">
            <Button
              component={NavLink}
              to="/"
              variant={!isArchetypesPage && !isStrategyPage ? 'light' : 'subtle'}
              color="marketBlue"
              radius="xl"
              size="compact-sm"
              className={classes.navButton}
            >
              Tutorial Desk
            </Button>
            <Button
              component={NavLink}
              to="/round-1-archetypes"
              variant={isArchetypesPage ? 'light' : 'subtle'}
              color="brass"
              radius="xl"
              size="compact-sm"
              className={classes.navButton}
            >
              Round 1 Archetypes
            </Button>
            <Button
              component={NavLink}
              to="/strategy-viewer"
              variant={isStrategyPage ? 'light' : 'subtle'}
              color="marketRed"
              radius="xl"
              size="compact-sm"
              className={classes.navButton}
            >
              Strategy Viewer
            </Button>
          </Group>

          <Group gap="xs">
            {badges.map(badge => (
              <Badge key={badge.label} variant="light" color={badge.color} radius="sm">
                {badge.label}
              </Badge>
            ))}
          </Group>
        </Group>
      </Container>
    </header>
  );
}
