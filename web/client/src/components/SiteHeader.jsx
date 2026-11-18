import { Link } from 'react-router-dom';
import { Logo } from './Icons.jsx';
import { useClinic } from '../hooks/useClinic.js';
import { patientAuth } from '../api.js';

export default function SiteHeader({ minimal = false }) {
  const clinic = useClinic();
  return (
    <header className="site-header">
      <div className="container header-row">
        <Link to="/" className="brand"><Logo /><span>{clinic.clinicName}</span></Link>
        {minimal ? (
          <span className="row gap">
            {patientAuth.token && <Link to="/patient" className="link-strong">My portal</Link>}
            <Link to="/" className="link-strong">Back to website</Link>
          </span>
        ) : (
          <nav aria-label="Main" className="main-nav">
            <a href="/#services">Services</a>
            {clinic.departments?.length > 0 && <a href="/#departments">Departments</a>}
            <a href="/#doctors">Doctors</a>
            {clinic.lab?.tests?.length > 0 && <a href="/#tests">Lab tests</a>}
            <a href="/#hours">Hours &amp; location</a>
            <Link to={patientAuth.token ? '/patient' : '/login'}>{patientAuth.token ? 'My portal' : 'Log in'}</Link>
            <Link to="/talk" className="btn btn-primary btn-pill">Book by voice</Link>
          </nav>
        )}
      </div>
    </header>
  );
}
