// A drop target with a real button: drag a file onto it, or choose one. The
// button is the contract (keyboard, screen reader); the drop is the shortcut.

import { useRef, useState, type DragEvent } from 'react';
import { Button } from '../../ui/Button';
import { Icon, type IconName } from '../../ui/icons/Icon';
import s from './Import.module.css';

export function DropZone({
  icon,
  title,
  hint,
  accept,
  choose,
  onFile,
}: {
  icon: IconName;
  title: string;
  hint: string;
  /** The file input's `accept`. */
  accept: string;
  /** The button's label. */
  choose: string;
  onFile: (file: File) => void;
}) {
  const input = useRef<HTMLInputElement | null>(null);
  const [over, setOver] = useState(false);
  const drop = (e: DragEvent) => {
    e.preventDefault();
    setOver(false);
    const f = e.dataTransfer.files[0];
    if (f) onFile(f);
  };
  return (
    <div
      className={over ? `${s.drop} ${s.dropOver}` : s.drop}
      onDragOver={(e) => {
        if (!e.dataTransfer.types.includes('Files')) return;
        e.preventDefault();
        setOver(true);
      }}
      onDragLeave={() => setOver(false)}
      onDrop={drop}
    >
      <span className={s.dropIcon} aria-hidden="true">
        <Icon name={icon} size={24} />
      </span>
      <h3 className={s.dropTitle}>{title}</h3>
      <p className={s.dropHint}>{hint}</p>
      <Button variant="primary" icon="upload" onClick={() => input.current?.click()}>
        {choose}
      </Button>
      <input
        ref={input}
        type="file"
        accept={accept}
        hidden
        aria-hidden="true"
        tabIndex={-1}
        onChange={(e) => {
          const f = e.target.files?.[0];
          e.target.value = '';
          if (f) onFile(f);
        }}
      />
    </div>
  );
}
