import { TitleBar } from './components/TitleBar';
import { Sidebar } from './components/Sidebar';
import { Toasts } from './components/Toasts';
import { VideoPreview } from './components/VideoPreview';
import { DashboardPage } from './pages/DashboardPage';
import { QueuePage } from './pages/QueuePage';
import { HistoryPage } from './pages/HistoryPage';
import { SettingsPage } from './pages/SettingsPage';
import { useAppStore } from './stores/appStore';
import { useWailsEvents } from './hooks/useWailsEvents';

function App() {
  useWailsEvents();
  const { activePage } = useAppStore();

  const renderPage = () => {
    switch (activePage) {
      case 'dashboard': return <DashboardPage />;
      case 'queue': return <QueuePage />;
      case 'history': return <HistoryPage />;
      case 'settings': return <SettingsPage />;
    }
  };

  return (
    <div className="flex flex-col h-screen bg-gray-950 text-gray-100 overflow-hidden">
      <TitleBar />
      <div className="flex flex-1 min-h-0">
        <Sidebar />
        <main className="flex-1 min-w-0 flex flex-col overflow-auto p-6">
          {renderPage()}
        </main>
      </div>
      <VideoPreview />
      <Toasts />
    </div>
  );
}

export default App;
