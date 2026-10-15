import type { Metadata } from "next";
import Link from "next/link";
import SectionHeading from "@/components/SectionHeading";
import ContactCta from "@/components/ContactCta";
import PageIdentityVisual from "@/components/PageIdentityVisual";

export const metadata: Metadata = {
  title: "Business",
  description:
    "OurFaces explores business relationships, partnerships, market opportunities, and long-term opportunities across markets.",
};

export default function BusinessPage() {
  return (
    <>
      <section className="shell page-hero page-hero-with-visual">
        <div className="page-hero-inner">
          <div className="kicker">Business</div>
          <h1>Connecting ideas, capabilities, and opportunities.</h1>
          <p className="lead">
            OurFaces explores business relationships, partnerships, and market opportunities with a practical,
            long-term approach.
          </p>
          <p className="support-line">Thoughtful partnerships. Practical opportunities. Long-term value.</p>
          <div className="inline-actions">
            <Link className="btn btn-primary" href="/contact">Start a Conversation</Link>
          </div>
        </div>
        <PageIdentityVisual variant="business" />
      </section>

      <section className="shell content-section compact">
        <SectionHeading
          kicker="Areas of interest"
          title="Where opportunity can take shape."
          copy={<p>We remain open to business opportunities that align with our capabilities, values, and long-term direction.</p>}
        />
        <div className="card-grid three">
          <article className="info-card simple-card">
            <h3>Partnerships</h3>
            <p>
              Build relationships with organizations, entrepreneurs, suppliers, and collaborators where there is a
              clear opportunity to create mutual value.
            </p>
          </article>
          <article className="info-card simple-card">
            <h3>Market Opportunities</h3>
            <p>
              Explore opportunities that connect products, services, ideas, and markets in a practical and sustainable
              way.
            </p>
          </article>
          <article className="info-card simple-card">
            <h3>Business Development</h3>
            <p>
              Evaluate opportunities carefully, with attention to fit, feasibility, timing, and long-term potential.
            </p>
          </article>
        </div>
      </section>

      <section className="shell content-section compact">
        <SectionHeading kicker="Our business approach" title="Our Business Approach" />
        <div className="panel-grid">
          <article className="panel">
            <h3>Relationships first</h3>
            <p>
              Strong business opportunities often begin with understanding the people, needs, and goals involved.
            </p>
          </article>
          <article className="panel">
            <h3>Measured growth</h3>
            <p>We prefer thoughtful, sustainable growth over expansion for its own sake.</p>
          </article>
        </div>
      </section>

      <section className="shell content-section compact">
        <div className="feature-panel">
          <div className="kicker">International perspective</div>
          <h2>Open to opportunities across markets.</h2>
          <p>
            OurFaces maintains an international outlook and remains open to opportunities that bring together
            business, products, services, and partnerships across markets.
          </p>
        </div>
      </section>

      <section className="shell content-section compact">
        <div className="feature-panel">
          <div className="kicker">Africantilles</div>
          <h2>Explore Africantilles</h2>
          <p>
            Africantilles is intended to serve as the customer-facing destination for selected products and future
            commercial offerings.
          </p>
          <div className="inline-actions">
            <span className="btn btn-secondary btn-disabled" aria-disabled="true">Coming Soon</span>
          </div>
        </div>
      </section>

      <section className="shell content-section compact">
        <SectionHeading kicker="What we look for" title="Good fit matters." />
        <div className="opportunity-list" aria-label="Opportunity qualities">
          <div>Practical</div>
          <div>Mutually beneficial</div>
          <div>Sustainable</div>
          <div>Aligned with long-term value</div>
        </div>
      </section>

      <ContactCta title="Have a business opportunity to discuss?">
        If you are exploring a partnership, market opportunity, sourcing relationship, or other business collaboration,
        we welcome the conversation.
      </ContactCta>
    </>
  );
}
