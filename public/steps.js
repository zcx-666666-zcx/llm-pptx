// Editing is local and never invokes the model or reprocesses other pages.
export function moveStep(page, index, direction) {
  const next = index + direction;
  if (next < 0 || next >= page.steps.length) return;
  [page.steps[index], page.steps[next]] = [page.steps[next], page.steps[index]];
}
export function mergeStep(page, index) {
  if (index < 1 || index >= page.steps.length) return;
  const previous = page.steps[index - 1], current = page.steps[index];
  if (previous.effect === 'emphasis' || current.effect === 'emphasis') throw new Error('强调步骤请单独保留');
  previous.targets = [...new Set([...previous.targets, ...current.targets])];
  previous.label = `${previous.label} / ${current.label}`.slice(0, 180);
  previous.duration = Math.max(previous.duration, current.duration);
  page.steps.splice(index, 1);
}
export function splitStep(page, index) {
  const current = page.steps[index]; if (!current || current.targets.length < 2) return;
  const id = current.targets.at(-1);
  const prefix = `split-${page.number}`;
  let suffix = 1; while (page.steps.some(s => s.id === `${prefix}-${suffix}`)) suffix++;
  current.targets = current.targets.slice(0, -1);
  page.steps.splice(index + 1, 0, { ...current, id: `${prefix}-${suffix}`, label: page.objects?.find(o => o.id === id)?.text.slice(0, 100) || '拆分的对象', targets: [id], trigger: 'click' });
}
export function compactPage(page) {
  const { number, fingerprint, policy, replaceExisting, transition, transitionDuration, steps } = page;
  return { number, fingerprint, policy, replaceExisting, transition, transitionDuration, steps: steps.map(({ id, label, targets, trigger, effect, duration }) => ({ id, label, targets, trigger, effect, duration })) };
}
export const compactPlan = plan => ({ version: plan.version, fingerprint: plan.fingerprint, slides: plan.slides.map(compactPage) });
