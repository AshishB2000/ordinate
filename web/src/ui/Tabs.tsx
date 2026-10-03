// Tabs — Radix Tabs (roving focus, ←/→ Home/End, automatic activation) in
// hub.css's underline set. Thin styled parts, so a screen composes them:
//
//   <Tabs value={tab} onValueChange={setTab}>
//     <TabList label="Dataset">
//       <Tab value="rows">Rows</Tab> <Tab value="profile" icon="chart-bar">Profile</Tab>
//     </TabList>
//     <TabPanel value="rows">…</TabPanel>
//   </Tabs>

import type { ReactNode } from 'react';
import * as T from '@radix-ui/react-tabs';
import { Icon, type IconName } from './icons/Icon';
import s from './Tabs.module.css';

export function Tabs({
  value,
  defaultValue,
  onValueChange,
  children,
}: {
  value?: string;
  defaultValue?: string;
  onValueChange?: (value: string) => void;
  children: ReactNode;
}) {
  return (
    <T.Root className={s.root} value={value} defaultValue={defaultValue} onValueChange={onValueChange}>
      {children}
    </T.Root>
  );
}

export function TabList({ label, children }: { label: string; children: ReactNode }) {
  return (
    <T.List className={s.list} aria-label={label}>
      {children}
    </T.List>
  );
}

export function Tab({
  value,
  icon,
  count,
  disabled,
  children,
}: {
  value: string;
  icon?: IconName;
  /** A figure the server already computed (a row count), shown as a pill. */
  count?: string;
  disabled?: boolean;
  children: ReactNode;
}) {
  return (
    <T.Trigger className={s.tab} value={value} disabled={disabled}>
      {icon && <Icon name={icon} />}
      <span>{children}</span>
      {count != null && <span className={s.count}>{count}</span>}
    </T.Trigger>
  );
}

export function TabPanel({ value, children }: { value: string; children: ReactNode }) {
  return (
    <T.Content className={s.panel} value={value}>
      {children}
    </T.Content>
  );
}
