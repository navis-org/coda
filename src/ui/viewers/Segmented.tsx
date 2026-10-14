/**
 * A segmented switch: a row of pressed/unpressed buttons choosing one of a few, on the NeuronBridge
 * card and the VFB Line Gallery. Its own `segmented` class, so restyling one card's switch is a
 * decision about both.
 */

/** One option of a segmented switch. */
export interface SegmentOption<T extends string> {
  id: T
  label: string
  disabled?: boolean
  title?: string
}

export function Segmented<T extends string>({
  label,
  options,
  value,
  onChange,
}: {
  label: string
  options: readonly SegmentOption<T>[]
  value: T | undefined
  onChange: (next: T) => void
}) {
  return (
    <span className="segmented" role="group" aria-label={label}>
      {options.map((option) => (
        <button
          key={option.id}
          type="button"
          aria-pressed={value === option.id}
          disabled={option.disabled}
          title={option.title}
          onClick={() => onChange(option.id)}
        >
          {option.label}
        </button>
      ))}
    </span>
  )
}
