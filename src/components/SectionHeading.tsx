import type { ReactNode } from "react";

type Props = {
  kicker?: string;
  title: ReactNode;
  copy?: ReactNode;
  centered?: boolean;
};

export default function SectionHeading({ kicker, title, copy, centered = false }: Props) {
  return (
    <div className={`section-heading${centered ? " centered" : ""}`}>
      <div>
        {kicker ? <div className="kicker">{kicker}</div> : null}
        <h2>{title}</h2>
      </div>
      {copy ? <div className="section-intro">{copy}</div> : null}
    </div>
  );
}
