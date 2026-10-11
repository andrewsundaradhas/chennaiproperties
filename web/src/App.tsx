import { BrowserRouter, Link, Route, Routes } from 'react-router-dom';
import { AdminApp } from './admin/AdminApp';
import { LeadDetailPage, ConversationPage } from './admin/LeadDetailPage';
import { LeadsPage } from './admin/LeadsPage';
import { OverviewPage } from './admin/OverviewPage';
import { PropertiesPage } from './admin/PropertiesPage';
import { PropertyFormPage } from './admin/PropertyFormPage';
import { ChatPage } from './chat/ChatPage';
import { EmptyState } from './components/ui';

export function AppRoutes() {
  return (
    <Routes>
      <Route path="/" element={<ChatPage />} />
      <Route path="/admin" element={<AdminApp />}>
        <Route index element={<OverviewPage />} />
        <Route path="properties" element={<PropertiesPage />} />
        <Route path="properties/new" element={<PropertyFormPage />} />
        <Route path="properties/:id" element={<PropertyFormPage />} />
        <Route path="leads" element={<LeadsPage />} />
        <Route path="leads/:id" element={<LeadDetailPage />} />
        <Route path="conversations/:id" element={<ConversationPage />} />
      </Route>
      <Route
        path="*"
        element={
          <EmptyState title="Page not found">
            <Link to="/">Go to the property assistant</Link>
          </EmptyState>
        }
      />
    </Routes>
  );
}

export default function App() {
  return (
    <BrowserRouter>
      <AppRoutes />
    </BrowserRouter>
  );
}
