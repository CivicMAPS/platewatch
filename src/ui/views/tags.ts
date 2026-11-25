/**
 * Tagged vehicles: plates tagged after a disability-permit or emergency-services dismissal.
 * Development build only — in EnforcementMAPS, tags are removed from the CommandMAPS operational
 * dashboard by supervisors and above with parking services branch authority.
 */
import { html, nothing } from 'lit-html';
import { deleteFlag, getFlags } from '../../lib/db';
import { FLAG_LABEL } from '../../lib/dismissal';
import { canRemoveTagsOnDevice, policyContext } from '../../lib/listPolicy';
import { formatDateTime, formatIsoDate } from '../../lib/time';
import type { PlateFlag } from '../../lib/types';
import type { App, View } from '../app';
import { banner, emptyState, header, icon, page, plateBadge, statusPill } from '../components';

export function tagsView(_p: Record<string, string>, app: App): View {
  let tags: PlateFlag[] = [];
  let loaded = false;
  const allowed = canRemoveTagsOnDevice(policyContext());

  const load = async () => {
    tags = (await getFlags()).sort((a, b) => b.createdAt - a.createdAt);
    loaded = true;
    app.update();
  };

  const remove = async (t: PlateFlag) => {
    const ok = await app.confirm({
      title: 'Remove tag',
      body: `${t.plate} will no longer raise the known-vehicle check and will be timed as usual.`,
      confirmLabel: 'Remove tag',
      danger: true,
    });
    if (!ok) return;
    await deleteFlag(t.key);
    app.toast(`Tag removed from ${t.plate}.`, 'success');
    await load();
  };

  return {
    mount: load,
    render() {
      return html`${header({ title: 'Tagged vehicles', subtitle: 'Disability permit and emergency vehicles', back: () => app.back() })}
        ${page(html`
          ${!allowed
            ? banner('pending', 'Tags are managed in CommandMAPS', 'Supervisors and above with parking services branch authority remove tags from the operational dashboard.', 'tags-not-available')
            : html`<div class="mb-4">${banner('pending', 'Development build', 'Inside EnforcementMAPS, tags are removed from the CommandMAPS operational dashboard by supervisors and above with parking services branch authority.', 'tags-dev-note')}</div>
              ${!loaded
                ? html`<p class="text-neutral-600">Loading…</p>`
                : tags.length === 0
                  ? emptyState('No tagged vehicles', 'A plate is tagged when an overstay alert is dismissed for a disability permit or an emergency services vehicle.')
                  : html`<ul class="card divide-y divide-neutral-200 py-1" data-testid="tag-list">
                      ${tags.map(
                        (t) => html`<li class="flex items-center gap-3 py-3" data-testid="tag-row">
                          <div class="min-w-0 flex-1">
                            <div class="flex flex-wrap items-center gap-2">${plateBadge(t.plate, 'sm')}${statusPill('reviewed', FLAG_LABEL[t.kind])}</div>
                            <p class="mt-1 text-xs text-neutral-600">Tagged ${formatDateTime(t.createdAt)}${t.confirmedDay ? ` · last confirmed ${formatIsoDate(t.confirmedDay)}` : ''}</p>
                          </div>
                          <button type="button" class="btn-ghost min-h-11 px-2" aria-label="Remove tag from ${t.plate}" data-testid="tag-remove" @click=${() => void remove(t)}>${icon('trash', 'h-4 w-4')}</button>
                        </li>`,
                      )}
                    </ul>`}`}
          ${nothing}
        `)}`;
    },
  };
}
