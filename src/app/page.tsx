import Link from "next/link";
import EarthVisual from "@/components/EarthVisual";
import SectionHeading from "@/components/SectionHeading";
import ContactCta from "@/components/ContactCta";

export default function HomePage() {
  return (
    <>
      <section className="shell home-hero">
        <div>
          <span className="eyebrow">Building what comes next</span>
          <h1 className="home-title">
            Ideas into <span className="accent">solutions.</span><br />
            Markets into connections.
          </h1>
          <p className="hero-copy">
            OurFaces develops practical technology solutions, explores business opportunities, and shares useful
            insights on emerging technologies and modern development practices.
          </p>
          <div className="hero-actions">
            <Link className="btn btn-primary" href="#what-we-do">Explore What We Do</Link>
            <Link className="btn btn-secondary" href="/contact">Contact Us</Link>
          </div>
        </div>
        <EarthVisual />
      </section>

      <section className="shell content-section" id="what-we-do">
        <SectionHeading
          kicker="What we do"
          title={<>Practical capabilities.<br />Meaningful opportunities.</>}
          copy={
            <p>
              OurFaces focuses on practical problem-solving, thoughtful use of technology, and business opportunities
              that can create lasting value.
            </p>
          }
        />
        <div className="card-grid two">
          <article className="info-card simple-card">
            <h3>Technology Solutions</h3>
            <p>
              We explore practical software solutions designed to improve workflows, organize information, support
              better decision-making, and reduce unnecessary manual work.
            </p>
            <Link className="text-link" href="/technology">Explore Technology →</Link>
          </article>
          <article className="info-card simple-card">
            <h3>Business Opportunities</h3>
            <p>
              We explore business relationships, partnerships, and opportunities that connect ideas, capabilities,
              and markets.
            </p>
            <Link className="text-link" href="/business">Explore Business →</Link>
          </article>
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
        <SectionHeading kicker="Our approach" title="Our Approach" />
        <div className="panel-grid">
          <article className="panel">
            <h3>Practical by design</h3>
            <p>
              We focus on useful, understandable, and maintainable solutions that address real needs rather than
              technology for its own sake.
            </p>
          </article>
          <article className="panel">
            <h3>Built to evolve</h3>
            <p>
              We take a measured approach—learning, validating, and expanding capabilities as needs and opportunities
              develop.
            </p>
          </article>
        </div>
      </section>

      <section className="shell content-section compact">
        <div className="feature-panel">
          <div className="kicker">Insights</div>
          <h2>Ideas worth sharing.</h2>
          <p>
            OurFaces shares selected insights on emerging technologies, software development, coding practices,
            AI-assisted workflows, and tools worth watching.
          </p>
          <div className="topic-strip" aria-label="Insight topics">
            <div className="topic-card">Emerging Technology</div>
            <div className="topic-card">Development Practices</div>
            <div className="topic-card">Tools &amp; Techniques</div>
          </div>
          <div className="inline-actions">
            <Link className="btn btn-primary" href="/insights">Explore Insights</Link>
            <span className="btn btn-secondary btn-disabled" aria-disabled="true">OurFaces Tech Brief — Coming Soon</span>
          </div>
        </div>
      </section>

      <section className="shell content-section compact">
        <SectionHeading kicker="About OurFaces" title="Built for practical solutions and long-term possibilities." />
        <div className="feature-panel">
          <p>
            OurFaces Import &amp; Export, LLC is a business focused on practical technology, business opportunities,
            and long-term value creation. We continue to evolve our capabilities while maintaining a flexible approach
            to future partnerships and markets.
          </p>
          <div className="inline-actions">
            <Link className="btn btn-secondary" href="/about">About OurFaces →</Link>
          </div>
        </div>
      </section>

      <ContactCta title="Interested in working with OurFaces?">
        Whether your interest is technology, business collaboration, partnerships, or future opportunities, we welcome
        the conversation.
      </ContactCta>
    </>
  );
}
