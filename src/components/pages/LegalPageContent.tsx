import type { ReactNode } from "react";
import type { Locale } from "@/lib/i18n";

type LegalPageKind = "privacy" | "accessibility" | "disclaimer";

type Section = {
  heading: string;
  body: ReactNode;
};

type LegalCopy = {
  eyebrow: string;
  title: string;
  intro: string;
  dateLabel: string;
  date: string;
  sections: Section[];
};

const contactEmail = "info@ourfaces.net";
const contactPhoneDisplay = "(860) 580-6814";
const contactPhoneHref = "+18605806814";

function ContactLinks({ locale }: { locale: Locale }) {
  return (
    <span>
      {locale === "fr" ? "Écrivez-nous à " : "Email us at "}
      <a href={`mailto:${contactEmail}`}>{contactEmail}</a>
      {locale === "fr" ? " ou appelez le " : " or call "}
      <a href={`tel:${contactPhoneHref}`}>{contactPhoneDisplay}</a>.
    </span>
  );
}

const privacyCopy: Record<Locale, LegalCopy> = {
  en: {
    eyebrow: "Privacy",
    title: "Privacy Policy",
    intro:
      "This Privacy Policy explains how OurFaces Import & Export, LLC handles personal information submitted through this website and certain technical information processed when the site is used.",
    dateLabel: "Effective date",
    date: "October 16, 2026",
    sections: [
      {
        heading: "Information you provide",
        body: (
          <>
            <p>When you use the Contact form, we may receive:</p>
            <ul>
              <li>your name and email address;</li>
              <li>your organization, if you choose to provide it;</li>
              <li>the inquiry category you select; and</li>
              <li>the message and other information you choose to include.</li>
            </ul>
          </>
        ),
      },
      {
        heading: "Technical information",
        body: (
          <p>
            The website infrastructure receives standard web-request information needed to deliver and secure the site. For example, an IP address may be processed for anti-abuse rate limiting, and our hosting provider may process standard request information such as timestamps, browser or device details, and network information in its service logs.
          </p>
        ),
      },
      {
        heading: "How we use information",
        body: (
          <>
            <p>We use information collected through the site to:</p>
            <ul>
              <li>receive and respond to inquiries;</li>
              <li>communicate about OurFaces services, projects, or business opportunities when requested;</li>
              <li>operate, protect, troubleshoot, and improve the website; and</li>
              <li>prevent spam, abuse, or misuse and comply with applicable legal obligations.</li>
            </ul>
          </>
        ),
      },
      {
        heading: "Service providers and sharing",
        body: (
          <p>
            OurFaces uses service providers to operate this website. The site is hosted using Vercel infrastructure, and Contact-form messages are transmitted to OurFaces through Zoho email services. These providers may process information as needed to provide their services. We do not sell personal information, and we do not use information submitted through this site for targeted advertising. We may disclose information when required by law, to protect rights or security, or in connection with a legitimate business transaction.
          </p>
        ),
      },
      {
        heading: "Cookies, analytics, and advertising",
        body: (
          <p>
            As of the effective date above, OurFaces does not use advertising cookies, behavioral-tracking pixels, or analytics scripts implemented through the website code. Hosting and security providers may use technical mechanisms or logs necessary to deliver, protect, and maintain their services. If our practices materially change, this policy will be updated.
          </p>
        ),
      },
      {
        heading: "Retention",
        body: (
          <p>
            Contact messages may be retained in OurFaces business email and records for as long as reasonably necessary to respond to the inquiry, maintain appropriate business records, resolve disputes, protect the site, or satisfy legal obligations. Service-provider logs are retained according to the providers&apos; applicable policies and configurations.
          </p>
        ),
      },
      {
        heading: "Your choices and privacy requests",
        body: (
          <p>
            Depending on applicable law, you may have rights concerning personal information about you, which may include requesting access, correction, or deletion. We may need to verify a request before acting on it. To make a privacy request, <ContactLinks locale="en" />
          </p>
        ),
      },
      {
        heading: "Children",
        body: (
          <p>
            This corporate website is not directed to children, and OurFaces does not knowingly solicit personal information from children through the Contact form. If you believe a child has provided personal information through the site, please contact us so we can review the matter.
          </p>
        ),
      },
      {
        heading: "Security",
        body: (
          <p>
            We use reasonable administrative and technical measures appropriate to the website and the information it processes. No internet transmission or electronic storage method can be guaranteed to be completely secure.
          </p>
        ),
      },
      {
        heading: "Changes to this policy",
        body: (
          <p>
            We may update this Privacy Policy as the website, business, service providers, or legal requirements change. The effective date at the top of this page will be updated when appropriate.
          </p>
        ),
      },
      {
        heading: "Contact",
        body: <p><ContactLinks locale="en" /></p>,
      },
    ],
  },
  fr: {
    eyebrow: "Confidentialité",
    title: "Politique de confidentialité",
    intro:
      "La présente Politique de confidentialité explique comment OurFaces Import & Export, LLC traite les renseignements personnels transmis par l’intermédiaire de ce site ainsi que certaines données techniques traitées lors de son utilisation.",
    dateLabel: "Date d’entrée en vigueur",
    date: "16 octobre 2026",
    sections: [
      {
        heading: "Renseignements que vous fournissez",
        body: (
          <>
            <p>Lorsque vous utilisez le formulaire de contact, nous pouvons recevoir :</p>
            <ul>
              <li>votre nom et votre adresse e-mail ;</li>
              <li>le nom de votre organisation, si vous choisissez de le fournir ;</li>
              <li>la catégorie de demande que vous sélectionnez ; et</li>
              <li>votre message ainsi que les autres renseignements que vous choisissez d’inclure.</li>
            </ul>
          </>
        ),
      },
      {
        heading: "Données techniques",
        body: (
          <p>
            L’infrastructure du site reçoit les données techniques standard nécessaires à la fourniture et à la sécurisation du site. Par exemple, une adresse IP peut être traitée pour limiter les abus, et notre fournisseur d’hébergement peut traiter dans ses journaux de service des informations standard telles que l’heure des requêtes, des renseignements sur le navigateur ou l’appareil et des données réseau.
          </p>
        ),
      },
      {
        heading: "Utilisation des renseignements",
        body: (
          <>
            <p>Nous utilisons les renseignements recueillis par le site afin de :</p>
            <ul>
              <li>recevoir les demandes et y répondre ;</li>
              <li>communiquer, lorsque cela est demandé, au sujet des services, projets ou possibilités commerciales d’OurFaces ;</li>
              <li>exploiter, protéger, dépanner et améliorer le site ; et</li>
              <li>prévenir le spam, les abus ou les utilisations abusives et respecter les obligations légales applicables.</li>
            </ul>
          </>
        ),
      },
      {
        heading: "Prestataires de services et partage",
        body: (
          <p>
            OurFaces fait appel à des prestataires pour exploiter ce site. Le site est hébergé sur l’infrastructure de Vercel et les messages envoyés par le formulaire de contact sont transmis à OurFaces au moyen des services de messagerie Zoho. Ces prestataires peuvent traiter des renseignements dans la mesure nécessaire à la fourniture de leurs services. Nous ne vendons pas les renseignements personnels et nous n’utilisons pas les renseignements transmis par ce site à des fins de publicité ciblée. Nous pouvons divulguer des renseignements lorsque la loi l’exige, pour protéger des droits ou la sécurité, ou dans le cadre d’une opération commerciale légitime.
          </p>
        ),
      },
      {
        heading: "Cookies, analyses et publicité",
        body: (
          <p>
            À la date d’entrée en vigueur indiquée ci-dessus, OurFaces n’utilise pas de cookies publicitaires, de pixels de suivi comportemental ni de scripts d’analyse ajoutés au code du site. Les fournisseurs d’hébergement et de sécurité peuvent utiliser les mécanismes techniques ou les journaux nécessaires à la fourniture, à la protection et à la maintenance de leurs services. Si nos pratiques changent de manière importante, la présente politique sera mise à jour.
          </p>
        ),
      },
      {
        heading: "Conservation",
        body: (
          <p>
            Les messages reçus peuvent être conservés dans la messagerie professionnelle et les dossiers d’OurFaces aussi longtemps que raisonnablement nécessaire pour répondre à la demande, tenir des dossiers professionnels appropriés, résoudre des différends, protéger le site ou satisfaire à des obligations légales. Les journaux des prestataires sont conservés conformément à leurs politiques et paramètres applicables.
          </p>
        ),
      },
      {
        heading: "Vos choix et demandes relatives à la confidentialité",
        body: (
          <p>
            Selon la loi applicable, vous pouvez disposer de droits concernant les renseignements personnels vous concernant, notamment le droit de demander l’accès, la correction ou la suppression. Nous pouvons devoir vérifier une demande avant d’y donner suite. Pour présenter une demande relative à la confidentialité, <ContactLinks locale="fr" />
          </p>
        ),
      },
      {
        heading: "Enfants",
        body: (
          <p>
            Ce site institutionnel n’est pas destiné aux enfants et OurFaces ne sollicite pas sciemment de renseignements personnels auprès d’enfants au moyen du formulaire de contact. Si vous pensez qu’un enfant a transmis des renseignements personnels par le site, veuillez nous contacter afin que nous puissions examiner la situation.
          </p>
        ),
      },
      {
        heading: "Sécurité",
        body: (
          <p>
            Nous mettons en œuvre des mesures administratives et techniques raisonnables, adaptées au site et aux renseignements qu’il traite. Aucune transmission sur Internet ni aucune méthode de stockage électronique ne peut toutefois être garantie comme totalement sécurisée.
          </p>
        ),
      },
      {
        heading: "Modifications de la présente politique",
        body: (
          <p>
            Nous pouvons mettre à jour la présente Politique de confidentialité lorsque le site, l’entreprise, les prestataires de services ou les exigences légales évoluent. La date d’entrée en vigueur figurant en haut de cette page sera mise à jour lorsque cela sera approprié.
          </p>
        ),
      },
      {
        heading: "Nous contacter",
        body: <p><ContactLinks locale="fr" /></p>,
      },
    ],
  },
};

const accessibilityCopy: Record<Locale, LegalCopy> = {
  en: {
    eyebrow: "Accessibility",
    title: "Accessibility Statement",
    intro:
      "OurFaces is committed to providing a website that is usable by as many people as reasonably possible, including people who use assistive technologies or alternative ways of navigating the web.",
    dateLabel: "Last reviewed",
    date: "October 16, 2026",
    sections: [
      {
        heading: "Our accessibility approach",
        body: (
          <p>
            We use the Web Content Accessibility Guidelines (WCAG) 2.2 Level AA as a practical accessibility benchmark. Our goal is ongoing accessibility improvement; this statement is not a third-party certification or a formal claim that every page or future item of content satisfies every WCAG success criterion in every environment.
          </p>
        ),
      },
      {
        heading: "Measures implemented",
        body: (
          <>
            <p>Accessibility features currently include:</p>
            <ul>
              <li>keyboard-accessible navigation, forms, links, and controls;</li>
              <li>a skip-to-main-content link and visible keyboard focus indicators;</li>
              <li>semantic headings and form labels;</li>
              <li>English and French page-language identification;</li>
              <li>text and layout support at increased browser zoom, including navigation at 400% zoom;</li>
              <li>support for reduced-motion preferences;</li>
              <li>screen-reader-friendly form status and error messages;</li>
              <li>mobile navigation that remains available independently of optional swipe navigation; and</li>
              <li>touch targets and responsive layouts intended to remain usable across common screen sizes.</li>
            </ul>
          </>
        ),
      },
      {
        heading: "Testing performed",
        body: (
          <p>
            The current site has been manually checked using keyboard-only navigation, forward and reverse tab navigation, 200% and 400% browser zoom, reduced-motion settings, mobile navigation, and Windows Narrator in both English and French contexts. Accessibility is an ongoing process, and changes to browsers, assistive technology, content, or the site itself may reveal issues that require additional work.
          </p>
        ),
      },
      {
        heading: "Need assistance or found a barrier?",
        body: (
          <p>
            If you have difficulty using any part of this website, need information in another format, or encounter an accessibility barrier, please tell us what page or feature caused the problem and, if useful, what browser or assistive technology you were using. <ContactLinks locale="en" />
          </p>
        ),
      },
      {
        heading: "Ongoing improvement",
        body: (
          <p>
            We will continue to review accessibility as the OurFaces website grows. New pages, features, documents, or third-party content may require additional testing and remediation.
          </p>
        ),
      },
    ],
  },
  fr: {
    eyebrow: "Accessibilité",
    title: "Déclaration d’accessibilité",
    intro:
      "OurFaces s’engage à proposer un site utilisable par le plus grand nombre raisonnablement possible de personnes, y compris celles qui utilisent des technologies d’assistance ou d’autres modes de navigation sur le Web.",
    dateLabel: "Dernière révision",
    date: "16 octobre 2026",
    sections: [
      {
        heading: "Notre approche de l’accessibilité",
        body: (
          <p>
            Nous utilisons les Règles pour l’accessibilité des contenus Web (WCAG) 2.2, niveau AA, comme référence pratique. Notre objectif est d’améliorer continuellement l’accessibilité ; la présente déclaration ne constitue ni une certification par un tiers ni une affirmation formelle selon laquelle chaque page ou futur contenu satisfait à tous les critères WCAG dans tous les environnements.
          </p>
        ),
      },
      {
        heading: "Mesures mises en œuvre",
        body: (
          <>
            <p>Les fonctions d’accessibilité actuellement mises en place comprennent :</p>
            <ul>
              <li>la navigation au clavier pour les menus, formulaires, liens et commandes ;</li>
              <li>un lien permettant d’aller directement au contenu principal et des indicateurs de focus visibles ;</li>
              <li>des titres structurés et des libellés de formulaire sémantiques ;</li>
              <li>l’identification de la langue des pages en anglais et en français ;</li>
              <li>la prise en charge du texte et de la mise en page avec un zoom du navigateur accru, y compris la navigation à 400 % ;</li>
              <li>la prise en charge de la préférence de réduction des animations ;</li>
              <li>des messages d’état et d’erreur du formulaire compatibles avec les lecteurs d’écran ;</li>
              <li>une navigation mobile qui reste disponible indépendamment de la navigation facultative par balayage ; et</li>
              <li>des zones tactiles et des mises en page adaptatives conçues pour rester utilisables sur les tailles d’écran courantes.</li>
            </ul>
          </>
        ),
      },
      {
        heading: "Tests effectués",
        body: (
          <p>
            Le site actuel a été vérifié manuellement au moyen d’une navigation uniquement au clavier, de la navigation par tabulation dans les deux sens, d’un zoom du navigateur à 200 % et 400 %, du réglage de réduction des animations, de la navigation mobile et de Windows Narrator dans des contextes anglais et français. L’accessibilité est un processus continu et les évolutions des navigateurs, technologies d’assistance, contenus ou du site lui-même peuvent révéler des problèmes nécessitant des corrections supplémentaires.
          </p>
        ),
      },
      {
        heading: "Besoin d’aide ou constat d’un obstacle ?",
        body: (
          <p>
            Si vous rencontrez des difficultés pour utiliser une partie du site, si vous avez besoin d’un renseignement dans un autre format ou si vous constatez un obstacle à l’accessibilité, indiquez-nous la page ou la fonction concernée et, si cela peut être utile, le navigateur ou la technologie d’assistance utilisée. <ContactLinks locale="fr" />
          </p>
        ),
      },
      {
        heading: "Amélioration continue",
        body: (
          <p>
            Nous continuerons à examiner l’accessibilité à mesure que le site OurFaces évolue. Les nouvelles pages, fonctions, documents ou contenus de tiers peuvent nécessiter des tests et des corrections supplémentaires.
          </p>
        ),
      },
    ],
  },
};

const disclaimerCopy: Record<Locale, LegalCopy> = {
  en: {
    eyebrow: "Website information",
    title: "Disclaimer",
    intro:
      "The information on the OurFaces website is provided for general informational and business-communication purposes. Please read the following limitations before relying on website content.",
    dateLabel: "Effective date",
    date: "October 16, 2026",
    sections: [
      {
        heading: "General information only",
        body: (
          <p>
            Website content is intended to describe OurFaces, its areas of interest, business direction, technology work, and general perspectives. It is not intended to replace advice from a qualified professional who can evaluate your specific circumstances.
          </p>
        ),
      },
      {
        heading: "No professional advice",
        body: (
          <p>
            Nothing on this site constitutes legal, financial, tax, investment, accounting, regulatory, cybersecurity, medical, or other professional advice. References to technology, artificial intelligence, business practices, sourcing, importing, exporting, or other topics are informational unless OurFaces expressly agrees otherwise in a separate written engagement.
          </p>
        ),
      },
      {
        heading: "Technology and Insights content",
        body: (
          <p>
            Technology changes quickly. Articles, observations, examples, and other Insights content may become outdated as products, software, standards, pricing, laws, or industry practices change. Users should verify important information independently before making decisions or implementing technical changes.
          </p>
        ),
      },
      {
        heading: "Business plans and future opportunities",
        body: (
          <p>
            Statements about future applications, partnerships, products, sourcing, trade, distribution, or other business opportunities describe intentions or areas being explored and are not guarantees that a particular product, service, transaction, partnership, launch date, or commercial activity will occur. Website content does not by itself constitute an offer, contract, investment solicitation, or commitment by OurFaces.
          </p>
        ),
      },
      {
        heading: "Accuracy and availability",
        body: (
          <p>
            We aim to keep website information useful and accurate, but we do not guarantee that all content will always be complete, current, error-free, or continuously available. We may update, correct, remove, or reorganize content without prior notice.
          </p>
        ),
      },
      {
        heading: "Third-party references and links",
        body: (
          <p>
            The site may refer to third-party products, services, standards, organizations, or websites. Unless expressly stated, such references do not imply sponsorship, endorsement, or control by OurFaces. Third parties are responsible for their own content, availability, privacy practices, and terms.
          </p>
        ),
      },
      {
        heading: "Use of the website",
        body: (
          <p>
            You are responsible for evaluating information before relying on it. To the extent permitted by applicable law, OurFaces is not responsible for losses arising solely from reliance on general website information where professional or situation-specific review would reasonably be appropriate.
          </p>
        ),
      },
      {
        heading: "Questions",
        body: <p>If you have questions about information published on this site, <ContactLinks locale="en" /></p>,
      },
    ],
  },
  fr: {
    eyebrow: "Informations du site",
    title: "Avis de non-responsabilité",
    intro:
      "Les informations publiées sur le site OurFaces sont fournies à des fins générales d’information et de communication commerciale. Veuillez tenir compte des limites suivantes avant de vous fier au contenu du site.",
    dateLabel: "Date d’entrée en vigueur",
    date: "16 octobre 2026",
    sections: [
      {
        heading: "Informations générales uniquement",
        body: (
          <p>
            Le contenu du site vise à présenter OurFaces, ses domaines d’intérêt, son orientation commerciale, ses travaux technologiques et ses perspectives générales. Il n’a pas pour objet de remplacer les conseils d’un professionnel qualifié capable d’examiner votre situation particulière.
          </p>
        ),
      },
      {
        heading: "Absence de conseil professionnel",
        body: (
          <p>
            Aucun contenu de ce site ne constitue un conseil juridique, financier, fiscal, en investissement, comptable, réglementaire, en cybersécurité, médical ou autre conseil professionnel. Les références à la technologie, à l’intelligence artificielle, aux pratiques commerciales, à l’approvisionnement, à l’importation, à l’exportation ou à d’autres sujets sont fournies à titre informatif, sauf accord écrit distinct et explicite d’OurFaces.
          </p>
        ),
      },
      {
        heading: "Contenu Technologie et Perspectives",
        body: (
          <p>
            La technologie évolue rapidement. Les articles, observations, exemples et autres contenus de la rubrique Perspectives peuvent devenir obsolètes à mesure que les produits, logiciels, normes, prix, lois ou pratiques du secteur évoluent. Les utilisateurs devraient vérifier de manière indépendante les informations importantes avant de prendre une décision ou de mettre en œuvre une modification technique.
          </p>
        ),
      },
      {
        heading: "Plans d’affaires et possibilités futures",
        body: (
          <p>
            Les déclarations concernant de futures applications, partenariats, produits, activités d’approvisionnement, de commerce, de distribution ou autres possibilités commerciales décrivent des intentions ou des domaines à l’étude et ne garantissent pas qu’un produit, service, partenariat, lancement, transaction ou activité commerciale précis aura lieu. Le contenu du site ne constitue pas, à lui seul, une offre, un contrat, une sollicitation d’investissement ou un engagement d’OurFaces.
          </p>
        ),
      },
      {
        heading: "Exactitude et disponibilité",
        body: (
          <p>
            Nous cherchons à maintenir des informations utiles et exactes, mais nous ne garantissons pas que tout le contenu sera toujours complet, à jour, exempt d’erreur ou disponible sans interruption. Nous pouvons mettre à jour, corriger, retirer ou réorganiser du contenu sans préavis.
          </p>
        ),
      },
      {
        heading: "Références et liens vers des tiers",
        body: (
          <p>
            Le site peut faire référence à des produits, services, normes, organisations ou sites Web de tiers. Sauf indication expresse, ces références n’impliquent ni parrainage, ni approbation, ni contrôle de la part d’OurFaces. Les tiers sont responsables de leur propre contenu, disponibilité, pratiques de confidentialité et conditions d’utilisation.
          </p>
        ),
      },
      {
        heading: "Utilisation du site",
        body: (
          <p>
            Il vous appartient d’évaluer les informations avant de vous y fier. Dans la mesure permise par la loi applicable, OurFaces n’est pas responsable des pertes découlant uniquement de la confiance accordée à des informations générales du site lorsqu’un examen professionnel ou adapté à la situation serait raisonnablement nécessaire.
          </p>
        ),
      },
      {
        heading: "Questions",
        body: <p>Pour toute question concernant les informations publiées sur ce site, <ContactLinks locale="fr" /></p>,
      },
    ],
  },
};

const allCopy: Record<LegalPageKind, Record<Locale, LegalCopy>> = {
  privacy: privacyCopy,
  accessibility: accessibilityCopy,
  disclaimer: disclaimerCopy,
};

export default function LegalPageContent({
  locale,
  kind,
}: {
  locale: Locale;
  kind: LegalPageKind;
}) {
  const copy = allCopy[kind][locale];

  return (
    <>
      <section className="page-hero legal-hero" lang={locale}>
        <div className="shell page-hero-inner">
          <div className="eyebrow">{copy.eyebrow}</div>
          <h1>{copy.title}</h1>
          <p className="lead">{copy.intro}</p>
          <p className="legal-date"><strong>{copy.dateLabel}:</strong> {copy.date}</p>
        </div>
      </section>

      <section className="legal-content" lang={locale}>
        <div className="shell legal-shell">
          {copy.sections.map((section) => (
            <section className="legal-section" key={section.heading}>
              <h2>{section.heading}</h2>
              <div className="legal-section-body">{section.body}</div>
            </section>
          ))}
        </div>
      </section>
    </>
  );
}
