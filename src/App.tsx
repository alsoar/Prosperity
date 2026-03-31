import '@mantine/core/styles.css';
import '@mantine/dropzone/styles.css';
import '@mantine/code-highlight/styles.css';

import { createTheme, MantineProvider } from '@mantine/core';
import { ReactNode } from 'react';
import { createBrowserRouter, createRoutesFromElements, Navigate, Route, RouterProvider } from 'react-router-dom';
import { RoundOneArchetypesPage } from './pages/archetypes/RoundOneArchetypesPage.tsx';
import { BasePage } from './pages/base/BasePage.tsx';
import { DashboardPage } from './pages/dashboard/DashboardPage.tsx';
import { useStore } from './store.ts';

const theme = createTheme({
  primaryColor: 'marketBlue',
  fontFamily: '"IBM Plex Sans", "Avenir Next", "Segoe UI", sans-serif',
  headings: {
    fontFamily: '"Iowan Old Style", "Palatino Linotype", "Book Antiqua", serif',
  },
  colors: {
    dark: [
      '#C1C2C5',
      '#A6A7AB',
      '#909296',
      '#5c5f66',
      '#373A40',
      '#2C2E33',
      '#25262b',
      '#1A1B1E',
      '#141517',
      '#101113',
    ],
    marketBlue: ['#eef5fb', '#d7e8f7', '#b7d2ea', '#95bbdd', '#749fcd', '#5685bc', '#3a6d9f', '#27567e', '#183d5d', '#0b243b'],
    marketRed: ['#fdf0ec', '#f8d8d0', '#f0b9ac', '#e79787', '#dc7462', '#cf5543', '#af3b2c', '#8c2e20', '#672016', '#45120d'],
    brass: ['#fcf6e8', '#f7ead0', '#efd6a1', '#e6c272', '#ddaf49', '#d29e31', '#b9851f', '#8f6714', '#66470c', '#3f2a05'],
  },
});

const router = createBrowserRouter(
  createRoutesFromElements(
    <Route path="/" element={<BasePage />}>
      <Route path="/" element={<DashboardPage />} />
      <Route path="round-1-archetypes" element={<RoundOneArchetypesPage />} />
      <Route path="*" element={<Navigate to="/" />} />
    </Route>,
  ),
  {
    basename: import.meta.env.BASE_URL,
  },
);

export function App(): ReactNode {
  const colorScheme = useStore(state => state.colorScheme);

  return (
    <MantineProvider theme={theme} defaultColorScheme={colorScheme}>
      <RouterProvider router={router} />
    </MantineProvider>
  );
}
