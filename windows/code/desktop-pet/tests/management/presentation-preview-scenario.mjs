import { createPresentationPreview } from '/presentation-preview.js';

const result = document.querySelector('#result');
const canvas = document.querySelector('#preview');
const statuses = [];
const assert = (condition, message) => { if (!condition) throw new Error(message); };
try {
  const preview = await createPresentationPreview({
    canvas,
    onStatus: value => statuses.push(value),
    assetBase: new URL('/presentation-assets/', location.href).href,
    shaderBase: new URL('/presentation-shaders/', location.href).href,
  });
  assert(statuses.some(value => value.state === 'ready'), 'Preview did not reach ready status');
  assert(canvas.width > 0 && canvas.height > 0, 'Canvas backing size is empty');
  assert(canvas.getContext('webgl'), 'The preview canvas has no WebGL context');
  const resources = performance.getEntriesByType('resource').map(item => new URL(item.name).pathname);
  assert(resources.includes('/presentation-assets/pet.model3.json'), 'Model manifest was not fetched');
  assert(resources.some(path => path.endsWith('.moc3')), 'Model geometry was not fetched');
  assert(resources.some(path => path.endsWith('.png')), 'Model texture was not fetched');
  assert(resources.some(path => path.startsWith('/presentation-shaders/')), 'Cubism shaders were not fetched');
  preview.resize();
  preview.dispose();
  assert(statuses.some(value => value.state === 'disposed'), 'Preview did not report disposal');
  result.textContent = JSON.stringify({ passed: 1, canvas: [canvas.width, canvas.height], resources: resources.filter(path => path.startsWith('/presentation-')) });
} catch (error) {
  result.textContent = JSON.stringify({ passed: 0, error: error.message, statuses });
}
result.dataset.complete = 'true';
