import * as React from "react";

type Props = React.HTMLAttributes<HTMLElement> & {
  as?: keyof React.JSX.IntrinsicElements;
};

/**
 * EditorialCard — the one Cumulus container.
 * 5.5px radius, 1px hairline border, no shadow.
 * The chrome is constant; the typography inside is free.
 */
export function EditorialCard({ as = "article", className = "", children, ...rest }: Props) {
  const Tag = as as any;
  return (
    <Tag className={`editorial-card ${className}`.trim()} {...rest}>
      {children}
    </Tag>
  );
}
