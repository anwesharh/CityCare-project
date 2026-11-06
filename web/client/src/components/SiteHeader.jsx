import { Link } from 'react-router-dom';
import { Logo } from './Icons.jsx';
import { useClinic } from '../hooks/useClinic.js';

export default function SiteHeader({ minimal = false }) {
  const clinic = useClinic();
  return (
    <header className="site-header">
      <div className="container header-row">
        <Link to="/" className="brand"><Logo /><span>{clinic.clinicName}</span></Link>
        {minimal ? (
          <Link to="/" className="link-strong">Back to website</Link>
        ) : (
          <nav aria-label="Main" className="main-nav">
            <a href="/#services">Services</a>
            {clinic.departments?.length > 0 && <a href="/#departments">Departments</a>}
            <a href="/#doctors">Doctors</a>
            {clinic.lab?.tests?.length > 0 && <a href="/#tests">Lab tests</a>}
            <a href="/#hours">Hours &amp; location</a>
            <Link to="/admin/login">Staff login</Link>
            <Link to="/talk" className="btn btn-primary btn-pill">Book by voice</Link>
          </nav>
        )}
      </div>
    </header>
  );
}
