import type { SVGProps } from "react";

/** The public component name stays compatible with upstream call sites. */
export function T3Wordmark(props: SVGProps<SVGSVGElement>) {
  return <svg {...props} viewBox="0 0 128 128" xmlns="http://www.w3.org/2000/svg"><circle cx="64" cy="64" r="47" fill="none" stroke="#b4a27b" strokeWidth="8" /></svg>;
}
