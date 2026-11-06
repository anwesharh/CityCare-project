// Inline stroke icons (decorative unless a label is given)
const base = { fill: 'none', stroke: 'currentColor', strokeWidth: 2, strokeLinecap: 'round', strokeLinejoin: 'round' };
const Svg = ({ size = 22, children, ...rest }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true" {...base} {...rest}>{children}</svg>
);

export const Logo = ({ size = 34, fill = '#0B5E57' }) => (
  <svg width={size} height={size} viewBox="0 0 34 34" aria-hidden="true">
    <rect x="1" y="1" width="32" height="32" rx="9" fill={fill} />
    <path d="M17 9v16M9 17h16" stroke="#fff" strokeWidth="3.2" strokeLinecap="round" />
  </svg>
);
export const MicIcon = (p) => <Svg {...p}><rect x="9" y="2" width="6" height="12" rx="3" /><path d="M5 10a7 7 0 0 0 14 0M12 17v5" /></Svg>;
export const MicOffIcon = (p) => <Svg {...p}><path d="M3 3l18 18M9 9v1a3 3 0 0 0 5.1 2.1M15 9.3V5a3 3 0 0 0-5.9-.8M5 10a7 7 0 0 0 11.5 5.4M19 10a7 7 0 0 1-.6 2.8M12 17v5" /></Svg>;
export const WaveIcon = (p) => <Svg {...p}><path d="M3 12h2M7 8v8M11 4v16M15 7v10M19 10v4" /></Svg>;
export const HangUpIcon = (p) => <Svg {...p}><path d="M3 14c5-5 13-5 18 0l-2.5 2.5-3-1.5v-2.5a10 10 0 0 0-7 0V15l-3 1.5z" /></Svg>;
export const CalendarIcon = (p) => <Svg {...p}><rect x="3" y="5" width="18" height="16" rx="2" /><path d="M16 3v4M8 3v4M3 10h18M9 15l2 2 4-4" /></Svg>;
export const RefreshIcon = (p) => <Svg {...p}><path d="M21 12a9 9 0 1 1-3-6.7L21 8M21 3v5h-5" /></Svg>;
export const QuestionIcon = (p) => <Svg {...p}><circle cx="12" cy="12" r="9" /><path d="M9.5 9a2.5 2.5 0 1 1 3.5 2.3c-.6.3-1 .9-1 1.6V14M12 17.5v.01" /></Svg>;
export const MessageIcon = (p) => <Svg {...p}><path d="M4 5h16v11H8l-4 4z" /><path d="M8 9h8M8 12h5" /></Svg>;
export const AlertIcon = (p) => <Svg {...p}><path d="M12 3l10 18H2z" /><path d="M12 10v5M12 18v.01" /></Svg>;
