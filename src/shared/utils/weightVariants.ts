import type { ParamSchema, WeightVariantsInfo } from '@shared/types/electron.d'

/**
 * Suffix the options of a node's variant-selecting param that are declared
 * weight variants but not installed. Other params, and values that are not
 * variant ids, are returned untouched. `installed` undefined means not known yet.
 */
export function withWeightVariantAvailability(
  param: ParamSchema,
  variants: WeightVariantsInfo | undefined,
  installed: string[] | undefined,
): ParamSchema {
  if (!variants || !installed || param.id !== variants.param || !param.options) return param
  const variantIds = new Set(variants.options.map((option) => option.id))
  return {
    ...param,
    options: param.options.map((option) => {
      const value = String(option.value)
      if (!variantIds.has(value) || installed.includes(value)) return option
      return { ...option, label: `${option.label ?? value} (not installed)` }
    }),
  }
}

/** True when `value` selects a declared weight variant that is known not to be installed. */
export function isMissingWeightVariant(
  paramId: string,
  value: unknown,
  variants: WeightVariantsInfo | undefined,
  installed: string[] | undefined,
): boolean {
  if (!variants || !installed || paramId !== variants.param) return false
  const id = String(value)
  return variants.options.some((option) => option.id === id) && !installed.includes(id)
}
