import { createRoot } from 'react-dom/client';
import App from './App';
import './ui/global.css';

// No StrictMode: its double-mount in dev creates two Phaser games on one canvas.
createRoot(document.getElementById('root')!).render(<App />);
