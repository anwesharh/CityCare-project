// src/clinic.js — the clinic's public details. Edit this file to change the website text.
export const CLINIC = {
  name: 'CityCare Clinic',
  timezone: 'Asia/Kolkata',
  tzOffset: '+05:30',
  address: ['12 Park Street, Kolkata', 'Near Park Street metro station'],
  mapEmbedUrl: '', // optional: paste a Google Maps "Embed a map" src URL here
  payments: 'Cash, UPI and all major cards accepted.',
  languages: 'English · বাংলা · हिन्दी',
  hours: [
    { days: 'Monday – Friday', time: '10:00 AM – 8:00 PM' },
    { days: 'Saturday', time: '10:00 AM – 2:00 PM' },
    { days: 'Sunday', time: 'Closed', closed: true },
  ],
  doctors: [
    { initials: 'DS', name: 'Dr. Sen', role: 'General physician', when: 'Weekday evenings · ₹500 consultation' },
    { initials: 'DD', name: 'Dr. Das', role: 'Paediatrician', when: 'Saturdays · ₹500 consultation', warm: true },
  ],
};
