import { Badge, Box, Container, Group, Text } from '@mantine/core';
import { IconChartDots } from '@tabler/icons-react';
import { ReactNode } from 'react';
import classes from './Header.module.css';

export function Header(): ReactNode {
  return (
    <header className={classes.header}>
      <Container fluid className={classes.inner}>
        <Group gap="md">
          <Box className={classes.brandMark}>
            <IconChartDots size={22} />
          </Box>
          <Box>
            <Text className={classes.title}>Prosperity Desk</Text>
            <Text className={classes.subtitle}>Hedgehogs-style tutorial market dashboard</Text>
          </Box>
        </Group>

        <Group gap="xs">
          <Badge variant="light" color="brass" radius="sm">
            Order Book
          </Badge>
          <Badge variant="light" color="marketBlue" radius="sm">
            Trades
          </Badge>
          <Badge variant="light" color="marketRed" radius="sm">
            Flow Proxy
          </Badge>
        </Group>
      </Container>
    </header>
  );
}
