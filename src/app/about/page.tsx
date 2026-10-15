import type { Metadata } from "next";
import Link from "next/link";
import SectionHeading from "@/components/SectionHeading";
import ContactCta from "@/components/ContactCta";
import PageIdentityVisual from "@/components/PageIdentityVisual";

export const metadata: Metadata = {
  title: "About",
  description:
    "Learn about OurFaces Import & Export, LLC, its vision, mission, values, and practical approach to technology and business opportunities.",
};

export default function AboutPage() {
  return (
    <>
      <section className="shell page-hero page-hero-with-visual">
        <div className="page-hero-inner">
          <div className="kicker">About OurFaces</div>
          <h1>Practical thinking. Long-term perspective.</h1>
          <p className="lead">
            OurFaces Import &amp; Export, LLC is a business focused on practical technology, business opportunities,
            and long-term value creation.
          </p>
          <p className="support-line">Building capabilities thoughtfully. Pursuing opportunities with purpose.</p>
        </div>
        <PageIdentityVisual variant="about" />
      </section>

      <section className="shell content-section compact">
        <SectionHeading kicker="Who we are" title="A business designed to evolve." />
        <div className="feature-panel">
          <p>
            OurFaces brings together practical problem-solving, technology, continuous learning, and business insight.
            We take a flexible approach that allows the company to develop new capabilities, explore opportunities,
            and grow as needs and markets evolve.
          </p>
        </div>
      </section>

      <section className="shell content-section compact">
        <div className="green-band split-band">
          <div>
            <h3>Our Vision</h3>
            <p>
              To create practical solutions and meaningful connections that help people, organizations, and markets
              work better.
            </p>
          </div>
          <div>
            <h3>Our Mission</h3>
            <p>
              OurFaces combines practical technology, continuous learning, and business insight to develop useful
              solutions and pursue opportunities with long-term value.
            </p>
          </div>
        </div>
      </section>

      <section className="shell content-section compact">
        <SectionHeading kicker="What guides us" title="What Guides Us" />
        <div className="card-grid four">
          <article className="info-card simple-card">
            <h3>Practicality</h3>
            <p>Focus on useful outcomes and real needs.</p>
          </article>
          <article className="info-card simple-card">
            <h3>Integrity</h3>
            <p>Approach relationships, information, and opportunities responsibly.</p>
          </article>
          <article className="info-card simple-card">
            <h3>Continuous Learning</h3>
            <p>Remain curious, evaluate new ideas, and adapt as technology and business evolve.</p>
          </article>
          <article className="info-card simple-card">
            <h3>Long-Term Value</h3>
            <p>Favor thoughtful decisions and sustainable opportunities over short-term activity.</p>
          </article>
        </div>
      </section>

      <section className="shell content-section compact">
        <SectionHeading kicker="How we work" title="How We Work" />
        <div className="panel-grid">
          <article className="panel">
            <h3>Understand before building</h3>
            <p>
              Good solutions begin with understanding the need, the people involved, and the environment in which the
              solution will be used.
            </p>
          </article>
          <article className="panel">
            <h3>Evaluate before expanding</h3>
            <p>
              Business opportunities deserve the same discipline—understand the fit, assess the value, and move
              forward when the conditions make sense.
            </p>
          </article>
        </div>
      </section>

      <section className="shell content-section compact">
        <div className="feature-panel">
          <div className="kicker">Our direction</div>
          <h2>Built for possibilities.</h2>
          <p>
            OurFaces continues to develop its technology capabilities while remaining open to business relationships,
            partnerships, and opportunities that align with the company’s direction and values.
          </p>
          <div className="inline-actions">
            <Link className="btn btn-secondary" href="/technology">Explore Technology →</Link>
            <Link className="btn btn-secondary" href="/business">Explore Business →</Link>
          </div>
        </div>
      </section>

      <section className="shell content-section compact">
        <SectionHeading kicker="Company information" title="OurFaces Import & Export, LLC" />
        <div className="company-block">
          <div className="company-card">
            <h3>Company</h3>
            <div className="company-lines">
              <span>OurFaces Import &amp; Export, LLC</span>
              <span>Connecticut limited liability company</span>
            </div>
          </div>
          <div className="company-card">
            <h3>Website</h3>
            <div className="company-lines">
              <span>ourfaces.net</span>
            </div>
          </div>
        </div>
      </section>

      <ContactCta title="Interested in learning more about OurFaces?">
        Whether you are exploring technology, collaboration, partnership opportunities, or another business connection,
        we welcome the conversation.
      </ContactCta>
    </>
  );
}
