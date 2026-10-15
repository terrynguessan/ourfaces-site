import type { Metadata } from "next";
import SectionHeading from "@/components/SectionHeading";
import ContactForm from "@/components/ContactForm";
import PageIdentityVisual from "@/components/PageIdentityVisual";

export const metadata: Metadata = {
  title: "Contact",
  description: "Contact OurFaces about technology, business opportunities, partnerships, insights, or general inquiries.",
};

export default function ContactPage() {
  return (
    <>
      <section className="shell page-hero page-hero-with-visual">
        <div className="page-hero-inner">
          <div className="kicker">Contact OurFaces</div>
          <h1>Start a conversation.</h1>
          <p className="lead">
            Whether your interest is technology, business collaboration, partnerships, or another opportunity, we
            welcome the conversation.
          </p>
          <p className="support-line">Tell us what you are exploring, and we’ll take it from there.</p>
        </div>
        <PageIdentityVisual variant="contact" />
      </section>

      <section className="shell content-section compact">
        <div className="contact-layout">
          <ContactForm />
          <aside className="direct-contact">
            <h2>Prefer to contact us directly?</h2>
            <p>Use the contact details below for general business inquiries.</p>
            <dl>
              <div>
                <dt>Email</dt>
                <dd><a href="mailto:info@ourfaces.net">info@ourfaces.net</a></dd>
              </div>
              <div>
                <dt>Phone</dt>
                <dd><a href="tel:+18605806814">(860) 580-6814</a></dd>
              </div>
            </dl>
          </aside>
        </div>
      </section>

      <section className="shell content-section compact">
        <SectionHeading kicker="Inquiry areas" title="Inquiry Areas" />
        <div className="inquiry-grid">
          <article className="inquiry-card">
            <h3>Technology</h3>
            <p>
              Workflow challenges, practical software needs, information organization, AI-related opportunities, and
              solution ideas.
            </p>
          </article>
          <article className="inquiry-card">
            <h3>Business</h3>
            <p>
              Partnerships, market opportunities, sourcing relationships, and other business collaborations.
            </p>
          </article>
          <article className="inquiry-card">
            <h3>Insights</h3>
            <p>
              Technology topics, content suggestions, knowledge-sharing, and potential collaboration around the
              OurFaces Tech Brief.
            </p>
          </article>
        </div>
      </section>

      <section className="shell content-section compact">
        <div className="note-box">
          <h3>What happens next</h3>
          <p>We review each inquiry and respond when there is a clear next step or additional information is needed.</p>
        </div>
      </section>

      <div className="shell privacy-note">
        Information submitted through this form will be used only to review and respond to your inquiry.
      </div>
    </>
  );
}
