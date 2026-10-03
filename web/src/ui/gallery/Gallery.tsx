// /dev/ui — every kit component in every state, for review in both themes.
// DEV-ONLY: routes.tsx registers it only under `import.meta.env.DEV` or the
// `gallery` build mode (web/scripts/ui-screens.mjs), so a production build
// tree-shakes the route and this chunk never ships.
//
//   ?open=1        menu, popover and tooltip mount open (one screenshot shows them)
//   ?open=dialog   the Dialog open        ?open=drawer   the Drawer open

import { useSearchParams } from 'react-router';
import { THEME_PREFS, useThemePref, type ThemePref } from '../../app/theme';
import { RadioGroup } from '../Choice';
import { ButtonsDemo, ChoicesDemo, FieldsDemo } from './ControlsDemo';
import { IconsDemo, LayoutDemo, StatesDemo } from './LayoutDemo';
import { FeedbackDemo, NavigationDemo, OverlaysDemo } from './OverlaysDemo';
import g from './Gallery.module.css';

const LABEL: Record<ThemePref, string> = { system: 'System', light: 'Light', dark: 'Dark' };

export default function Gallery() {
  const [params] = useSearchParams();
  const open = params.get('open');
  const [theme, setTheme] = useThemePref();
  return (
    <div className={g.page} data-gallery-ready="">
      <header className={g.head}>
        <div>
          <h1 className={g.title}>UI kit</h1>
          <p className={g.note}>web/src/ui — development only, not in the production bundle.</p>
        </div>
        <RadioGroup
          label="Theme"
          orientation="horizontal"
          value={theme}
          onValueChange={(v) => setTheme(v as ThemePref)}
          options={THEME_PREFS.map((p) => ({ value: p, label: LABEL[p] }))}
        />
      </header>
      <ButtonsDemo />
      <FieldsDemo />
      <ChoicesDemo />
      <OverlaysDemo open={open} />
      <NavigationDemo />
      <FeedbackDemo seed={open === '1'} />
      <StatesDemo />
      <LayoutDemo />
      <IconsDemo />
    </div>
  );
}
