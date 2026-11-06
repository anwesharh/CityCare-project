import React from 'react';
import ReactDOM from 'react-dom/client';
import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom';
import './styles.css';
import Home from './pages/Home.jsx';
import Talk from './pages/Talk.jsx';
import Login from './pages/Login.jsx';
import Dashboard from './pages/Dashboard.jsx';
import Appointments from './pages/Appointments.jsx';
import Calls from './pages/Calls.jsx';
import CallDetail from './pages/CallDetail.jsx';
import Messages from './pages/Messages.jsx';
import Patients from './pages/Patients.jsx';
import PatientDetail from './pages/PatientDetail.jsx';
import Analytics from './pages/Analytics.jsx';
import Live from './pages/Live.jsx';
import Settings from './pages/Settings.jsx';
import Staff from './pages/Staff.jsx';
import Account from './pages/Account.jsx';
import OpdBoard from './pages/OpdBoard.jsx';
import Reports from './pages/Reports.jsx';
import QueueDisplay from './pages/QueueDisplay.jsx';
import { RequireAuth } from './components/AdminLayout.jsx';

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <BrowserRouter>
      <Routes>
        <Route path="/" element={<Home />} />
        <Route path="/talk" element={<Talk />} />
        <Route path="/queue" element={<QueueDisplay />} />
        <Route path="/admin/login" element={<Login />} />
        <Route path="/admin" element={<RequireAuth><Dashboard /></RequireAuth>} />
        <Route path="/admin/appointments" element={<RequireAuth><Appointments /></RequireAuth>} />
        <Route path="/admin/calls" element={<RequireAuth roles={['admin', 'staff', 'doctor']}><Calls /></RequireAuth>} />
        <Route path="/admin/calls/:id" element={<RequireAuth roles={['admin', 'staff', 'doctor']}><CallDetail /></RequireAuth>} />
        <Route path="/admin/messages" element={<RequireAuth roles={['admin', 'staff', 'doctor']}><Messages /></RequireAuth>} />
        <Route path="/admin/patients" element={<RequireAuth roles={['admin', 'staff', 'doctor']}><Patients /></RequireAuth>} />
        <Route path="/admin/patients/:key" element={<RequireAuth roles={['admin', 'staff', 'doctor']}><PatientDetail /></RequireAuth>} />
        <Route path="/admin/analytics" element={<RequireAuth roles={['admin', 'staff']}><Analytics /></RequireAuth>} />
        <Route path="/admin/live" element={<RequireAuth roles={['admin', 'staff']}><Live /></RequireAuth>} />
        <Route path="/admin/settings" element={<RequireAuth roles={['admin']}><Settings /></RequireAuth>} />
        <Route path="/admin/staff" element={<RequireAuth roles={['admin']}><Staff /></RequireAuth>} />
        <Route path="/admin/account" element={<RequireAuth><Account /></RequireAuth>} />
        <Route path="/admin/opd" element={<RequireAuth><OpdBoard /></RequireAuth>} />
        <Route path="/admin/reports" element={<RequireAuth roles={['admin', 'staff', 'lab']}><Reports /></RequireAuth>} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </BrowserRouter>
  </React.StrictMode>,
);
