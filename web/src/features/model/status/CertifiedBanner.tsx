// A standing line on a certified dataset's Prepare page: its steps are part of what was certified.

import { Icon } from '../../../ui/icons/Icon';
import type { StatusView } from './status';
import s from './Status.module.css';

export function CertifiedBanner({ status }: { status?: StatusView }) {
  if (status?.state !== 'certified') return null;
  return (
    <p className={s.banner} role="note">
      <Icon name="circle-check" size={16} />
      {`Certified by ${status.by}. Changes here need a project admin to certify it again.`}
    </p>
  );
}
