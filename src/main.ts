import { store } from './state/store';
import { webgpuAvailable } from './sim/gpu';
import { fieldPage } from './pages/fieldPage';
import { brinePage } from './pages/brinePage';
import { crystalPage } from './pages/crystalPage';
import { weatherPage } from './pages/weatherPage';
import { harvestPage } from './pages/harvestPage';

const PAGES: Record<string, (root: HTMLElement) => void> = {
  field: fieldPage,
  brine: brinePage,
  crystal: crystalPage,
  weather: weatherPage,
  harvest: harvestPage,
};

const badge = document.getElementById('backendBadge')!;
badge.textContent = webgpuAvailable() ? 'WebGPU 可用' : 'WebGPU 不可用 · CPU 模式';
if (!webgpuAvailable()) store.settings.forceCpu = true;

const root = document.getElementById('page')!;
const tabs = document.getElementById('tabs')!;
let current = 'field';

function render(name: string) {
  current = name;
  root.innerHTML = '';
  tabs.querySelectorAll('button').forEach((b) => b.classList.toggle('active', b.dataset.page === name));
  PAGES[name](root);
}

tabs.addEventListener('click', (e) => {
  const b = (e.target as HTMLElement).closest('button');
  if (b?.dataset.page) render(b.dataset.page);
});

store.restore().finally(() => render(current));
