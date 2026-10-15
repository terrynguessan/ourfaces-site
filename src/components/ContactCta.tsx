import Link from "next/link";

type Props = {
  title: string;
  children: React.ReactNode;
};

export default function ContactCta({ title, children }: Props) {
  return (
    <section className="shell contact-cta-wrap" aria-label="Contact OurFaces">
      <div className="contact-cta">
        <div>
          <div className="kicker kicker-gold">OurFaces Import &amp; Export, LLC</div>
          <h2>{title}</h2>
          <p>{children}</p>
        </div>
        <Link className="btn btn-light" href="/contact">
          Contact OurFaces
        </Link>
      </div>
    </section>
  );
}
