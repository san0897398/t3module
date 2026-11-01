import { cx, type CxOptions } from 'class-variance-authority';
import { extendTailwindMerge } from 'tailwind-merge';
const merge = extendTailwindMerge({ extend: { theme: { text: ['2xs','3xs','4xs','5xs'] } } });
export const cn = (...values: CxOptions) => merge(cx(values));
