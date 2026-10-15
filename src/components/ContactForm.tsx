"use client";

import { FormEvent, useState } from "react";

type SubmitState = "idle" | "sending" | "success" | "error";

export default function ContactForm() {
  const [submitState, setSubmitState] = useState<SubmitState>("idle");
  const [statusMessage, setStatusMessage] = useState("");

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const formElement = event.currentTarget;
    const form = new FormData(formElement);

    setSubmitState("sending");
    setStatusMessage("");

    try {
      const response = await fetch("/api/contact", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: form.get("name"),
          email: form.get("email"),
          organization: form.get("organization"),
          topic: form.get("topic"),
          message: form.get("message"),
          website: form.get("website"),
        }),
      });

      const result = (await response.json()) as { ok?: boolean; error?: string };

      if (!response.ok || !result.ok) {
        throw new Error(result.error || "Unable to send your message.");
      }

      formElement.reset();
      setSubmitState("success");
      setStatusMessage("Thank you. Your message has been sent to OurFaces.");
    } catch (error) {
      setSubmitState("error");
      setStatusMessage(error instanceof Error ? error.message : "Unable to send your message.");
    }
  }

  return (
    <form className="contact-form" onSubmit={handleSubmit}>
      <div className="form-grid">
        <label>
          <span>Name</span>
          <input name="name" type="text" autoComplete="name" maxLength={120} required />
        </label>
        <label>
          <span>Email</span>
          <input name="email" type="email" autoComplete="email" maxLength={254} required />
        </label>
      </div>

      <label>
        <span>Organization <em>Optional</em></span>
        <input name="organization" type="text" autoComplete="organization" maxLength={160} />
      </label>

      <label>
        <span>What would you like to discuss?</span>
        <select name="topic" defaultValue="General Inquiry">
          <option>Technology</option>
          <option>Business Opportunity</option>
          <option>Partnership / Collaboration</option>
          <option>Africantilles</option>
          <option>Insights / Tech Brief</option>
          <option>General Inquiry</option>
        </select>
      </label>

      <label>
        <span>Message</span>
        <textarea name="message" rows={7} maxLength={5000} required />
      </label>

      <div className="contact-honeypot" aria-hidden="true">
        <label>
          <span>Website</span>
          <input name="website" type="text" tabIndex={-1} autoComplete="off" />
        </label>
      </div>

      <button className="btn btn-primary" type="submit" disabled={submitState === "sending"}>
        {submitState === "sending" ? "Sending…" : "Send Message"}
      </button>

      {statusMessage && (
        <p className={`form-status ${submitState === "success" ? "success" : "error"}`} role="status" aria-live="polite">
          {statusMessage}
        </p>
      )}
    </form>
  );
}
