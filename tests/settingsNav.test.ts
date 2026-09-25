import { describe, expect, it } from 'vitest';
import {
  SETTINGS_ROOT,
  SETTINGS_SECTIONS,
  isActiveSettingsSection,
  isSettingsPath,
} from '@/lib/staff/settingsNav';

// SET-1 — the settings nav definition shared by the sidebar/pill nav
// (components/staff/settings/SettingsNav.tsx) and the "Settings" tab in
// StaffHeader. These are the two pure pieces both places rely on.

describe('SETTINGS_SECTIONS', () => {
  it('lists overview, printers, store and counter, in that order', () => {
    expect(SETTINGS_SECTIONS.map((s) => s.href)).toEqual([
      '/staff/settings',
      '/staff/settings/printers',
      '/staff/settings/store',
      '/staff/settings/counter',
    ]);
  });

  it('every href starts with the settings root', () => {
    for (const section of SETTINGS_SECTIONS) {
      expect(section.href === SETTINGS_ROOT || section.href.startsWith(`${SETTINGS_ROOT}/`)).toBe(true);
    }
  });
});

describe('isActiveSettingsSection', () => {
  it('matches the overview row only on the exact root path', () => {
    expect(isActiveSettingsSection('/staff/settings', SETTINGS_ROOT)).toBe(true);
    expect(isActiveSettingsSection('/staff/settings/', SETTINGS_ROOT)).toBe(true);
  });

  it('does not match the overview row for a sub-section path', () => {
    expect(isActiveSettingsSection('/staff/settings/printers', SETTINGS_ROOT)).toBe(false);
  });

  it('matches a sub-section on its own exact path', () => {
    expect(isActiveSettingsSection('/staff/settings/printers', '/staff/settings/printers')).toBe(true);
  });

  it('matches a sub-section on a nested path under it', () => {
    expect(isActiveSettingsSection('/staff/settings/printers/anything', '/staff/settings/printers')).toBe(
      true,
    );
  });

  it('does not match a different sub-section, even with a shared prefix', () => {
    expect(isActiveSettingsSection('/staff/settings/store', '/staff/settings/printers')).toBe(false);
  });

  it('works on a surface-shortened path too (staff.hioc.in strips /staff)', () => {
    expect(isActiveSettingsSection('/settings/printers', '/settings/printers')).toBe(true);
    expect(isActiveSettingsSection('/settings', '/settings')).toBe(true);
  });
});

describe('isSettingsPath', () => {
  it('is true for the root and any nested settings path', () => {
    expect(isSettingsPath('/staff/settings')).toBe(true);
    expect(isSettingsPath('/staff/settings/printers')).toBe(true);
    expect(isSettingsPath('/staff/settings/counter')).toBe(true);
  });

  it('is false for anything else, including a route that merely shares the prefix', () => {
    expect(isSettingsPath('/staff/settings-legacy')).toBe(false);
    expect(isSettingsPath('/staff/menu')).toBe(false);
    expect(isSettingsPath('/staff')).toBe(false);
  });
});
