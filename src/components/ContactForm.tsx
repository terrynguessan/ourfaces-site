"use client";

import { FormEvent, useState } from "react";
import { contactFailure } from "@/lib/contactResponse";
import type { Locale } from "@/lib/i18n";

type SubmitState = "idle" | "sending" | "success" | "error";

const copy = {
  en: {
    name: "Name",
    email: "Email",
    organization: "Organization",
    optional: "Optional",
    topicLabel: "What would you like to discuss?",
    message: "Message",
    website: "Website",
    sending: "Sending…",
    send: "Send Message",
    success: "Thank you. Your message has been sent to OurFaces.",
    error: "Unable to send your message. Please try again.",
    tooMany: "Too many messages have been sent from your connection. Please wait a few minutes and try again.",
    tooLarge: "Your message is too long. Please shorten it and try again.",
    topics: [
      ["Technology", "Technology"],
      ["Business Opportunity", "Business Opportunity"],
      ["Partnership / Collaboration", "Partnership / Collaboration"],
      ["Africantilles", "Africantilles"],
      ["Insights / Tech Brief", "Insights / Tech Brief"],
      ["General Inquiry", "General Inquiry"],
    ],
  },
  fr: {
    name: "Nom",
    email: "E-mail",
    organization: "Organisation",
    optional: "Facultatif",
    topicLabel: "De quoi souhaitez-vous discuter ?",
    message: "Message",
    website: "Site web",
    sending: "Envoi…",
    send: "Envoyer le message",
    success: "Merci. Votre message a été envoyé à OurFaces.",
    error: "Impossible d’envoyer votre message. Veuillez réessayer.",
    tooMany: "Trop de messages ont été envoyés depuis votre connexion. Veuillez patienter quelques minutes avant de réessayer.",
    tooLarge: "Votre message est trop long. Veuillez le raccourcir et réessayer.",
    topics: [
      ["Technology", "Technologie"],
      ["Business Opportunity", "Opportunité commerciale"],
      ["Partnership / Collaboration", "Partenariat / Collaboration"],
      ["Africantilles", "Africantilles"],
      ["Insights / Tech Brief", "Perspectives / Tech Brief"],
      ["General Inquiry", "Demande générale"],
    ],
  },
} as const;

export default function ContactForm({ locale = "en" }: { locale?: Locale }) {
  const [submitState, setSubmitState] = useState<SubmitState>("idle");
  const [statusMessage, setStatusMessage] = useState("");
  const t = copy[locale];

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

      const failure = await contactFailure(response, locale, t);
      if (failure !== null) {
        setSubmitState("error");
        setStatusMessage(failure);
        return;
      }

      formElement.reset();
      setSubmitState("success");
      setStatusMessage(t.success);
    } catch {
      // Network failure: never show the browser's raw error text.
      setSubmitState("error");
      setStatusMessage(t.error);
    }
  }

  return (
    <form className="contact-form" onSubmit={handleSubmit} aria-busy={submitState === "sending"}>
      <div className="form-grid">
        <label>
          <span>{t.name}</span>
          <input name="name" type="text" autoComplete="name" maxLength={120} required />
        </label>
        <label>
          <span>{t.email}</span>
          <input name="email" type="email" autoComplete="email" maxLength={254} required />
        </label>
      </div>

      <label>
        <span>{t.organization} <em>{t.optional}</em></span>
        <input name="organization" type="text" autoComplete="organization" maxLength={160} />
      </label>

      <label>
        <span>{t.topicLabel}</span>
        <select name="topic" defaultValue="General Inquiry">
          {t.topics.map(([value, label]) => (
            <option key={value} value={value}>{label}</option>
          ))}
        </select>
      </label>

      <label>
        <span>{t.message}</span>
        <textarea name="message" rows={7} maxLength={5000} required />
      </label>

      <div className="contact-honeypot" aria-hidden="true">
        <label>
          <span>{t.website}</span>
          <input name="website" type="text" tabIndex={-1} autoComplete="off" />
        </label>
      </div>

      <button className="btn btn-primary" type="submit" disabled={submitState === "sending"}>
        {submitState === "sending" ? t.sending : t.send}
      </button>

      {statusMessage && (
        <p className={`form-status ${submitState === "success" ? "success" : "error"}`} role={submitState === "error" ? "alert" : "status"} aria-live={submitState === "error" ? "assertive" : "polite"}>
          {statusMessage}
        </p>
      )}
    </form>
  );
}
