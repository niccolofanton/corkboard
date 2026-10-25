import { Corkboard } from 'corkboard-dist';

// `?fallback=1` forces the public texture upload path (the one used when Pixi's private members are gone).
if (new URLSearchParams(location.search).has('fallback')) globalThis.__corkboardForcePublicUpload = true;

window.Corkboard = Corkboard;
window.__ready = true;
