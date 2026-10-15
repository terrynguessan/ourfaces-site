import type { Metadata } from "next";
import Link from "next/link";
import SectionHeading from "@/components/SectionHeading";
import ContactCta from "@/components/ContactCta";
import PageIdentityVisual from "@/components/PageIdentityVisual";

export const metadata: Metadata = {
  title: "Insights",
  description:
    "Selected insights from OurFaces on emerging technology, development practices, tools, techniques, and applied AI.",
};

export default function InsightsPage() {
  return (
    <>
      <section className="shell page-hero page-hero-with-visual">
        <div className="page-hero-inner">
          <div className="kicker">Insights</div>
          <h1>Useful ideas. Practical perspective.</h1>
          <p className="lead">
            OurFaces shares selected insights on emerging technologies, software development, coding practices,
            AI-assisted workflows, and tools worth understanding.
          </p>
          <p className="support-line">Curated for relevance, clarity, and practical value.</p>
          <div className="inline-actions">
            <a className="btn btn-primary" href="#topics">Explore Topics</a>
          </div>
        </div>
        <PageIdentityVisual variant="insights" />
      </section>

      <section className="shell content-section compact" id="topics">
        <SectionHeading kicker="What we cover" title="Topics worth following." />
        <div className="card-grid four">
          <article className="info-card simple-card">
            <h3>Emerging Technology</h3>
            <p>
              Developments in artificial intelligence, software platforms, infrastructure, and other technologies
              that may shape how people and organizations work.
            </p>
          </article>
          <article className="info-card simple-card">
            <h3>Development Practices</h3>
            <p>
              Practical approaches to software design, testing, maintainability, deployment, and responsible
              development.
            </p>
          </article>
          <article className="info-card simple-card">
            <h3>Tools &amp; Techniques</h3>
            <p>
              Selected tools, frameworks, coding techniques, and workflows that may improve productivity or software
              quality.
            </p>
          </article>
          <article className="info-card simple-card">
            <h3>Applied AI</h3>
            <p>
              Practical uses of AI in development, knowledge work, automation, decision support, and other real-world
              applications.
            </p>
          </article>
        </div>
      </section>

      <section className="shell content-section compact">
        <SectionHeading kicker="Our editorial approach" title="Our Editorial Approach" />
        <div className="panel-grid">
          <article className="panel">
            <h3>Curated, not crowded</h3>
            <p>
              We focus on selected topics that appear useful, relevant, or worth understanding rather than trying to
              cover every technology trend.
            </p>
          </article>
          <article className="panel">
            <h3>Practical over promotional</h3>
            <p>
              The goal is to highlight ideas, techniques, and tools that can be evaluated and applied in real-world
              work.
            </p>
          </article>
        </div>
      </section>

      <section className="shell content-section compact">
        <SectionHeading kicker="Featured Insights" title="Featured Insights" />
        <div className="placeholder-box">
          <p>New articles and technology notes will be added as they are published.</p>
          <div className="topic-strip" aria-label="Featured insight categories">
            <div className="topic-card">Technology Trends</div>
            <div className="topic-card">Development Practices</div>
            <div className="topic-card">Tools Worth Watching</div>
          </div>
        </div>
      </section>

      <section className="shell content-section compact">
        <div className="green-band">
          <div className="kicker kicker-gold">OurFaces Tech Brief</div>
          <h2 className="panel-title">A concise look at technology worth knowing.</h2>
          <p>
            The OurFaces Tech Brief will bring together selected technology developments, coding practices, useful
            tools, and practical lessons in a concise format.
          </p>
          <div className="tech-brief-grid">
            <div className="brief-item"><strong>Worth Knowing</strong><span>A development or idea worth understanding.</span></div>
            <div className="brief-item"><strong>Worth Trying</strong><span>A tool, technique, or workflow that may deserve experimentation.</span></div>
            <div className="brief-item"><strong>Better Practice</strong><span>A practical software-development or engineering principle.</span></div>
            <div className="brief-item"><strong>On the Watch List</strong><span>An emerging technology or trend worth monitoring.</span></div>
          </div>
          <div className="inline-actions">
            <span className="btn btn-light btn-disabled" aria-disabled="true">Tech Brief coming soon</span>
          </div>
        </div>
      </section>

      <section className="shell content-section compact">
        <div className="feature-panel">
          <div className="kicker">From learning to practice</div>
          <h2>Learning should lead to better solutions.</h2>
          <p>
            Following technology is most useful when it improves how problems are understood and how solutions are
            designed. OurFaces approaches learning with practical application in mind.
          </p>
          <div className="inline-actions">
            <Link className="btn btn-secondary" href="/technology">Explore Technology Solutions →</Link>
          </div>
        </div>
      </section>

      <ContactCta title="Have an idea or topic worth discussing?">
        If you would like to share a technology perspective, suggest a topic, or explore a related collaboration, we
        welcome the conversation.
      </ContactCta>
    </>
  );
}
