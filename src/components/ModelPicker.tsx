import { modelKey, parseModelKey } from '../providers';
import { useSettings } from '../state/settings';
import type { ModelRef } from '../state/types';

/** Provider-grouped model selector over all enabled providers. */
export function ModelPicker({
  value,
  onChange,
  id,
  allowEmpty,
}: {
  value: ModelRef | undefined;
  onChange: (ref: ModelRef) => void;
  id?: string;
  allowEmpty?: boolean;
}) {
  const settings = useSettings();
  const providers = settings.providers.filter((p) => p.enabled);
  const current = value ? modelKey(value) : '';
  const known = new Set(providers.flatMap((p) => p.models.map((m) => modelKey({ providerId: p.id, model: m }))));

  return (
    <select
      id={id}
      className="select"
      value={current}
      onChange={(e) => {
        if (e.target.value) onChange(parseModelKey(e.target.value));
      }}
    >
      {allowEmpty || !current ? <option value="">Select a model…</option> : null}
      {value && current && !known.has(current) ? (
        <option value={current}>
          {value.model} ({settings.providers.find((p) => p.id === value.providerId)?.name ?? value.providerId})
        </option>
      ) : null}
      {providers.map((p) => (
        <optgroup key={p.id} label={p.name}>
          {p.models.length ? (
            p.models.map((m) => (
              <option key={m} value={modelKey({ providerId: p.id, model: m })}>
                {m}
              </option>
            ))
          ) : (
            <option disabled value={`__none_${p.id}`}>
              No models yet — add or fetch them in Settings
            </option>
          )}
        </optgroup>
      ))}
    </select>
  );
}
