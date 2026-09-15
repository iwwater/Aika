import type { MenuContext, MenuEntry, PetMenuPlugin } from '../types';

const LABELS = {
  en: {
    openSettings: 'Open settings',
    wave: 'Wave',
    pauseWalking: 'Pause walking',
    roam: 'Let me roam',
    hidePet: 'Hide pet',
  },
  'zh-CN': {
    openSettings: '打开设置',
    wave: '挥手',
    pauseWalking: '暂停移动',
    roam: '自由移动',
    hidePet: '隐藏宠物',
  },
} as const;

/**
 * Default menu: the four entries the upstream right-click menu offered, plus one entry
 * per appearance the active renderer offers (MVP-11).
 *
 * Entries never mutate the pet directly; they go through the supplied callbacks so
 * actions still obey the renderer's validation and round constraints. Appearance
 * entries are generated from `context.appearances`, so this plugin stays unaware of
 * which renderer is running and of any concrete model.
 */
export class DefaultMenuPlugin implements PetMenuPlugin {
  readonly id = 'default';
  readonly displayName = 'Default pet menu';

  entries(context: MenuContext): readonly MenuEntry[] {
    const labels = LABELS[context.language];
    const appearances = context.appearances ?? [];
    const entries: MenuEntry[] = [
      {
        id: 'open-settings',
        label: labels.openSettings,
        run: () => context.openSettings(),
      },
      {
        id: 'wave',
        label: labels.wave,
        run: () => context.playAction('waving'),
      },
      {
        id: 'toggle-walking',
        label: context.settings.autonomousWalking ? labels.pauseWalking : labels.roam,
        run: () =>
          context.updateSettings({
            ...context.settings,
            autonomousWalking: !context.settings.autonomousWalking,
          }),
      },
      {
        id: 'hide-pet',
        label: labels.hidePet,
        run: () => context.hidePet(),
      },
    ];

    // 只有一种外观时不给入口：那会是一个永远切不出变化的死菜单项。
    if (appearances.length > 1) {
      for (const appearance of appearances) {
        const active = appearance.id === context.settings.live2dAppearance;
        entries.push({
          id: `appearance:${appearance.id}`,
          label: active ? `• ${appearance.label}` : appearance.label,
          run: () =>
            context.updateSettings({ ...context.settings, live2dAppearance: appearance.id }),
        });
      }
    }

    return entries;
  }
}
