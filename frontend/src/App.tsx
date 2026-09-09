import { Route, Routes } from 'react-router-dom';
import { Layout } from './components/Layout';
import { ArticlePage } from './pages/ArticlePage';
import { CalendarPage } from './pages/CalendarPage';
import { DashboardPage } from './pages/DashboardPage';
import { NewsPage } from './pages/NewsPage';
import { PortfolioPage } from './pages/PortfolioPage';
import { TickerPage } from './pages/TickerPage';
import { WatchlistPage } from './pages/WatchlistPage';

export function App() {
  return (
    <Routes>
      <Route element={<Layout />}>
        <Route index element={<DashboardPage />} />
        <Route path="calendar" element={<CalendarPage />} />
        <Route path="watchlist" element={<WatchlistPage />} />
        <Route path="portfolio" element={<PortfolioPage />} />
        <Route path="news" element={<NewsPage />} />
        <Route path="articles/:slug" element={<ArticlePage />} />
        <Route path="tickers/:symbol" element={<TickerPage />} />
      </Route>
    </Routes>
  );
}
