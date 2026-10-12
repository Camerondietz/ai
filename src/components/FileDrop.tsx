import { useState, type ReactNode } from 'react';
import { pickFiles } from '../lib/download';

export function FileDrop({
  accept,
  multiple,
  onFiles,
  children,
}: {
  accept: string;
  multiple?: boolean;
  onFiles: (files: File[]) => void;
  children: ReactNode;
}) {
  const [over, setOver] = useState(false);
  return (
    <div
      className={`dropzone ${over ? 'over' : ''}`}
      role="button"
      tabIndex={0}
      onClick={async () => {
        const files = await pickFiles(accept, multiple);
        if (files.length) onFiles(files);
      }}
      onKeyDown={async (e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          const files = await pickFiles(accept, multiple);
          if (files.length) onFiles(files);
        }
      }}
      onDragOver={(e) => {
        e.preventDefault();
        setOver(true);
      }}
      onDragLeave={() => setOver(false)}
      onDrop={(e) => {
        e.preventDefault();
        setOver(false);
        const files = Array.from(e.dataTransfer.files);
        if (files.length) onFiles(multiple ? files : files.slice(0, 1));
      }}
    >
      {children}
    </div>
  );
}
