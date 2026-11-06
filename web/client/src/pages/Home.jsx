import { Link } from 'react-router-dom';
import SiteHeader from '../components/SiteHeader.jsx';
import { AlertIcon, CalendarIcon, MessageIcon, MicIcon, QuestionIcon, RefreshIcon } from '../components/Icons.jsx';
import { hoursRows, useClinic } from '../hooks/useClinic.js';

const initials = (name) => name.replace(/^Dr\.?\s*/i, '').split(/\s+/).map((w) => w[0]).join('').slice(0, 2).toUpperCase() || 'DR';

const SERVICES = [
  { Icon: CalendarIcon, title: 'Book appointments', text: 'Checks live availability and confirms the time before booking.' },
  { Icon: RefreshIcon, title: 'Cancel or reschedule', text: 'Finds your booking from the phone number you booked with.' },
  { Icon: QuestionIcon, title: 'Answer questions', text: 'Fees, doctors, timings, payment options and directions.' },
  { Icon: MessageIcon, title: 'Take messages', text: 'Passes your message to clinic staff for a callback.' },
];

const HOSPITAL_SERVICES = [
  { Icon: CalendarIcon, title: 'Book lab tests', text: 'Tells you the price and preparation, like fasting, and books a slot.' },
  { Icon: QuestionIcon, title: 'Report status', text: 'Tells you if your lab or scan report is ready to collect.' },
];

export default function Home() {
  const clinic = useClinic();
  const rows = hoursRows(clinic.hours);
  const em = clinic.emergency || {};
  const lab = clinic.lab;
  const isHospital = Boolean(clinic.departments?.length || em.phone || lab?.tests?.length);
  const services = isHospital && lab?.tests?.length ? [...SERVICES, ...HOSPITAL_SERVICES] : SERVICES;
  const doctorGroups = groupDoctors(clinic.doctors || []);
  return (
    <div className="page">
      <SiteHeader />

      <section className="container hero">
        <div className="hero-copy">
          <span className="tag">AI receptionist · {clinic.languages}</span>
          <h1 className="hero-title">Book, cancel or reschedule your visit — just by talking.</h1>
          <p className="lead">Our receptionist answers questions about fees, doctors and timings, and books appointments
            straight into the clinic calendar. Day or night, no waiting on hold.</p>
          <div className="hero-actions">
            <Link to="/talk" className="btn btn-primary btn-pill btn-lg"><MicIcon /> Talk to our receptionist</Link>
            <a href="#hours" className="link-strong">See timings</a>
          </div>
          <p className="muted small">Uses your microphone in the browser. Calls may be recorded for quality. No medical advice is given.</p>
        </div>
        <div className="card hero-chat" aria-label="Example conversation">
          <div className="chat-head">
            <div className="chat-avatar"><svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="2" strokeLinecap="round" aria-hidden="true"><path d="M3 12h2M7 8v8M11 5v14M15 8v8M19 11v2" /></svg></div>
            <div><strong>Receptionist</strong><br /><span className="muted small">Example conversation</span></div>
          </div>
          <div className="bubble bubble-agent">Namaste, thank you for calling {clinic.clinicName}. How can I help you today?</div>
          <div className="bubble bubble-you">I'd like to see Dr. Sen tomorrow evening.</div>
          <div className="bubble bubble-agent">I have 6:00 PM or 6:30 PM free tomorrow. Which suits you?</div>
        </div>
      </section>

      <section id="services" className="container section">
        <h2 className="h-section">What the receptionist can do</h2>
        <div className="card-grid">
          {services.map(({ Icon, title, text }) => (
            <div key={title} className="card feature">
              <Icon size={28} stroke="#0B5E57" />
              <h3>{title}</h3>
              <p>{text}</p>
            </div>
          ))}
        </div>
        <div className="emergency-box">
          <AlertIcon size={28} stroke="#A3261A" />
          {em.phone || em.ambulancePhone ? (
            <p><strong>Medical emergency?</strong> Call our 24x7 emergency{em.phone && <> on <a href={`tel:${em.phone.replace(/\s/g, '')}`}><strong>{em.phone}</strong></a></>}
              {em.ambulancePhone && <>, ambulance <a href={`tel:${em.ambulancePhone.replace(/\s/g, '')}`}><strong>{em.ambulancePhone}</strong></a></>}, or <strong>112</strong>.
              {em.note ? ` ${em.note}` : ''} If you describe emergency symptoms, the receptionist gives you these numbers and alerts our staff.</p>
          ) : (
            <p><strong>Medical emergency?</strong> Don't use the receptionist. Call <strong>112</strong> or go to the nearest
              hospital. If you describe emergency symptoms, the receptionist will tell you the same and alert our staff.</p>
          )}
        </div>
      </section>

      {clinic.departments?.length > 0 && (
        <section id="departments" className="container section">
          <h2 className="h-section">Departments</h2>
          <div className="card-grid">
            {clinic.departments.map((d) => (
              <div key={d.name} className="card dept">
                <h3>{d.name}</h3>
                {d.description && <p>{d.description}</p>}
                {d.location && <span className="muted small">{d.location}</span>}
              </div>
            ))}
          </div>
        </section>
      )}

      <section id="doctors" className="band">
        <div className="container section">
          <h2 className="h-section">Our doctors</h2>
          {doctorGroups.map(([dept, docs]) => (
            <div key={dept || 'all'} className="stack">
              {dept && doctorGroups.length > 1 && <h3 className="h-sub">{dept}</h3>}
              <div className="card-grid wide">
                {docs.map((d, i) => (
                  <div key={d.name} className="doctor">
                    <div className={`doctor-avatar${i % 2 ? ' warm' : ''}`}>{initials(d.name)}</div>
                    <div><strong className="doctor-name">{d.name}</strong><br /><span>{d.specialty}</span><br />
                      <span className="muted small">{[d.days, d.room && `Room ${d.room}`, d.fee && `${d.fee} consultation`].filter(Boolean).join(' · ')}</span></div>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      </section>

      {(lab?.tests?.length > 0 || lab?.packages?.length > 0) && (
        <section id="tests" className="container section">
          <div><h2 className="h-section">Lab tests and health check-ups</h2>
            <p className="lead-sm">Ask the receptionist to book any of these and it will tell you how to prepare.</p></div>
          {lab.packages?.length > 0 && (
            <div className="card-grid">
              {lab.packages.map((p) => (
                <div key={p.name} className="card package">
                  <div className="row-between"><h3>{p.name}</h3>{p.price && <span className="price">{p.price}</span>}</div>
                  {p.includes && <p>{p.includes}</p>}
                  {p.prep && <span className="muted small">Preparation: {p.prep}</span>}
                </div>
              ))}
            </div>
          )}
          {lab.tests?.length > 0 && (
            <div className="card table-wrap">
              <table className="table">
                <thead><tr><th>Test</th><th>Price</th><th>Preparation</th><th>Report</th></tr></thead>
                <tbody>{lab.tests.map((t) => (
                  <tr key={t.name}><td><strong>{t.name}</strong></td><td>{t.price || '—'}</td><td>{t.prep || '—'}</td><td>{t.reportTime || '—'}</td></tr>
                ))}</tbody>
              </table>
              {lab.collectInfo && <p className="muted small">{lab.collectInfo}</p>}
            </div>
          )}
        </section>
      )}

      <section id="hours" className="container section two-col">
        <div className="card">
          <h2 className="h-card-lg">{isHospital ? 'OPD hours' : 'Clinic hours'}</h2>
          <dl className="hours">
            {rows.map((h) => (
              <div key={h.days}><dt>{h.days}</dt><dd className={h.closed ? 'closed' : ''}>{h.time}</dd></div>
            ))}
          </dl>
          <p className="muted small">The receptionist takes bookings and messages 24/7.</p>
          {clinic.visitingHours && <><h3 className="h-sub">Visiting hours</h3><p>{clinic.visitingHours}</p></>}
          {clinic.insuranceInfo && <><h3 className="h-sub">Insurance and cashless</h3><p>{clinic.insuranceInfo}</p></>}
        </div>
        <div className="card">
          <h2 className="h-card-lg">Find us</h2>
          <p className="lead-sm">{clinic.addressLines?.[0]}<br />{clinic.addressLines?.[1]}</p>
          {clinic.mapEmbedUrl
            ? <iframe title="Map" src={clinic.mapEmbedUrl} className="map" loading="lazy" />
            : <div className="map map-empty">Map: add a Google Maps embed link in Clinic settings</div>}
          <p>{clinic.payments}</p>
        </div>
      </section>

      <footer className="footer">
        <div className="container footer-row">
          <span>© {clinic.clinicName} · {new Date().getFullYear()}</span>
          <span>Your data is handled under India's DPDP Act 2023.</span>
        </div>
      </footer>
    </div>
  );
}

/** [[department, doctors], ...] keeping the order doctors were entered in. */
function groupDoctors(doctors) {
  const map = new Map();
  for (const d of doctors) {
    const k = d.department || '';
    if (!map.has(k)) map.set(k, []);
    map.get(k).push(d);
  }
  return [...map.entries()];
}
