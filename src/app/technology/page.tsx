import type { Metadata } from "next";
import Link from "next/link";
import SectionHeading from "@/components/SectionHeading";
import ContactCta from "@/components/ContactCta";
import PageIdentityVisual from "@/components/PageIdentityVisual";

export const metadata: Metadata = {
  title: "Technology Solutions",
  description:
    "OurFaces explores practical software solutions for workflows, information, decision support, and responsible applied AI.",
};

export default function TechnologyPage() {
  return (
    <>
      <section className="shell page-hero page-hero-with-visual">
        <div className="page-hero-inner">
          <div className="kicker">Technology Solutions</div>
          <h1>Practical technology for real-world needs.</h1>
          <p className="lead">
            OurFaces explores practical software solutions designed to improve workflows, organize information,
            support better decision-making, and reduce unnecessary manual work.
          </p>
          <p className="support-line">Thoughtful solutions. Practical implementation. Long-term value.</p>
          <div className="inline-actions">
            <Link className="btn btn-primary" href="/contact">Start a Conversation</Link>
          </div>
        </div>
        <PageIdentityVisual variant="technology" />
      </section>

      <section className="shell content-section compact">
        <SectionHeading
          kicker="What we focus on"
          title="Technology with a practical purpose."
          copy={<p>We focus on areas where technology can simplify work, improve access to information, and support more effective processes.</p>}
        />
        <div className="card-grid four">
          <article className="info-card simple-card">
            <h3>Workflow Improvement</h3>
            <p>Identify repetitive or inefficient processes and explore practical ways to simplify, organize, or automate them.</p>
          </article>
          <article className="info-card simple-card">
            <h3>Information &amp; Knowledge</h3>
            <p>Structure information so it is easier to find, understand, maintain, and use when it matters.</p>
          </article>
          <article className="info-card simple-card">
            <h3>Decision Support</h3>
            <p>Develop tools that help present relevant information clearly and support informed decisions.</p>
          </article>
          <article className="info-card simple-card">
            <h3>Applied AI</h3>
            <p>Explore responsible uses of artificial intelligence where it can improve efficiency, knowledge access, and user experience.</p>
          </article>
        </div>
      </section>

      <section className="shell content-section compact">
        <SectionHeading kicker="How we think" title="How We Think About Solutions" />
        <div className="panel-grid">
          <article className="panel">
            <h3>Start with the problem</h3>
            <p>
              Technology should serve a clear purpose. We begin by understanding the need, the workflow, and the people
              involved before considering the solution.
            </p>
          </article>
          <article className="panel">
            <h3>Build for usefulness</h3>
            <p>
              A solution should be understandable, maintainable, and appropriate for the environment in which it will
              be used.
            </p>
          </article>
        </div>
      </section>

      <section className="shell content-section compact">
        <SectionHeading kicker="Our technology principles" title="Our Technology Principles" />
        <div className="principles">
          <div className="principle"><strong>Practical</strong><span>Solve a real need.</span></div>
          <div className="principle"><strong>Simple</strong><span>Avoid unnecessary complexity.</span></div>
          <div className="principle"><strong>Maintainable</strong><span>Build with long-term usability in mind.</span></div>
          <div className="principle"><strong>Responsible</strong><span>Use technology, including AI, thoughtfully and appropriately.</span></div>
        </div>
      </section>

      <section className="shell content-section compact">
        <SectionHeading kicker="Solutions" title="Solutions" />
        <div className="placeholder-box">
          <h3>Solutions coming soon</h3>
          <p>
            OurFaces is developing its technology capabilities with a focus on practical, useful applications.
            Published solutions will be featured here as they become available.
          </p>
        </div>
      </section>

      <section className="shell content-section compact">
        <div className="feature-panel">
          <div className="kicker">Insights</div>
          <h2>Learning informs better solutions.</h2>
          <p>
            OurFaces follows emerging technologies, development practices, and tools with an emphasis on what is
            practical, useful, and worth understanding.
          </p>
          <div className="inline-actions">
            <Link className="btn btn-secondary" href="/insights">Explore Insights →</Link>
          </div>
        </div>
      </section>

      <ContactCta title="Have a technology need or idea?">
        If you are exploring a workflow challenge, information problem, or opportunity where technology may help, we
        welcome the conversation.
      </ContactCta>
    </>
  );
}
