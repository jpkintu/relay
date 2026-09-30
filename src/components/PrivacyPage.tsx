import { ArrowLeft } from 'lucide-react';
import { useSession } from '../lib/session';
import { formatMoney } from '../lib/format';
import { BrandMark } from './BrandMark';

// The privacy notice and terms of use (/privacy), readable without signing
// in. The restaurant's name, contact and how long customer details are kept
// come from Admin → Data & privacy. A starting text: the owner should have it
// checked against the law that applies to them.
export function PrivacyPage() {
  const { appInfo, user } = useSession();
  // Relay Hosted: before a restaurant is chosen, Relay's own terms.
  if (appInfo.hosted && !appInfo.found) return <PlatformTerms />;
  const name = appInfo.restaurantName || 'The restaurant';
  const contact = appInfo.privacy?.contact || '';
  const months = appInfo.privacy?.retentionMonths || 0;
  const kept = months
    ? `${months} months after the order`
    : 'for as long as the restaurant keeps its order records';
  return (
    <main className="privacy-page">
      <header>
        <BrandMark logo={appInfo.restaurantLogo} name={appInfo.restaurantName} />
        <a className="privacy-back" href="/">
          <ArrowLeft aria-hidden /> {user ? 'Back to the app' : 'Back to sign in'}
        </a>
      </header>
      <article>
        <h1>Privacy and terms</h1>
        <p className="lead">
          {name} uses Relay to take and deliver orders and to account for the money. This page says
          what information that involves, why, who can see it and how long it is kept.
        </p>

        <h2>Customers</h2>
        <p>
          When you order, we record your <b>name</b>, <b>phone number</b>, <b>delivery address</b>{' '}
          and any directions, and sometimes a <b>map pin</b> of where to deliver. We use them only
          to prepare and deliver your order, to contact you about it, and to fill in your details
          the next time you order.
        </p>
        <p>
          Your details are seen by the rider delivering your order, the cashiers and the owner of{' '}
          {name}. They are not sold or shared for advertising. Maps are shown with OpenStreetMap,
          which receives the area being viewed but not your name or number.
        </p>
        <p>
          Your details are kept <b>{kept}</b>
          {months
            ? '. After that they are removed; the amounts stay in the books, without your name.'
            : '.'}{' '}
          You can ask at any time to see them, correct them or have them removed.
        </p>

        <h2>People who work here</h2>
        <p>
          Riders, cashiers and the owner have their own account. Relay records your name, phone
          number, username, shifts, the orders you take, deliver or handle, the cash you collect and
          hand over, and changes you make. This record exists to keep the money accountable and to
          settle disagreements fairly; the owner can see it. Relay does not track where you are.
        </p>

        <h2>Using Relay at work</h2>
        <ul>
          <li>
            Your account and PIN are yours alone. Do not share them or sign in as someone else.
          </li>
          <li>
            Enter what really happened: amounts collected, handed over and paid out are checked
            against each other.
          </li>
          <li>
            Use customers’ details only for their orders. Do not copy them or contact customers for
            anything else.
          </li>
          <li>
            When you leave, the owner switches your account off. Records of your work stay with the
            restaurant.
          </li>
        </ul>

        <h2>Where the information is kept</h2>
        <p>
          Relay stores its records with Back4App, a hosting service, on servers that may be outside
          your country. Connections are encrypted. Notifications on your phone go through your
          phone’s own notification service (Google or Apple).
        </p>

        <h2>Questions and requests</h2>
        <p>
          {contact ? (
            <>
              Contact {name}: <b>{contact}</b>.
            </>
          ) : (
            <>Ask {name} directly, in person or by phone.</>
          )}{' '}
          You can ask what we hold about you, have it corrected or removed, or complain about how it
          is handled. You may also complain to your country’s data protection authority (in Uganda,
          the Personal Data Protection Office).
        </p>
        <p className="muted small">Relay is software by Embiro Concepts, used by {name}.</p>
      </article>
    </main>
  );
}

// Relay Hosted: the terms a restaurant accepts when it signs up. A starting
// text; have it checked against the law that applies before relying on it.
export function PlatformTerms() {
  const { appInfo } = useSession();
  const platform = appInfo.platform;
  const trial = appInfo.trialDays || 0;
  const price = platform ? formatMoney(platform.monthlyPrice, platform.currency) : '';
  const contact = platform?.supportContact || '';
  return (
    <main className="privacy-page">
      <header>
        <BrandMark />
        <a className="privacy-back" href="/">
          <ArrowLeft aria-hidden /> Back
        </a>
      </header>
      <article>
        <h1>Relay terms for restaurants</h1>
        <p className="lead">
          Relay runs your restaurant’s orders, riders, kitchen and cash on our servers for a monthly
          subscription. These terms apply when you create a restaurant on Relay.
        </p>

        <h2>Trial and subscription</h2>
        <ul>
          <li>
            A new restaurant gets a free trial{trial ? ` of ${trial} days` : ''}. No payment is
            taken during the trial.
          </li>
          <li>
            After the trial, Relay starts at {price ? <b>{price} a month</b> : 'a monthly fee'}.
            Your restaurant’s price may be agreed with you, higher or lower, depending on its size
            and needs; it is always shown in the app before you pay.
          </li>
          <li>
            You pay in the app with mobile money (through ioTec Pay), for 1 to 12 months at a time,
            or directly to Relay by arrangement. Each payment extends your paid period; it is not
            renewed automatically.
          </li>
          <li>
            If a period ends unpaid, the app keeps working for{' '}
            {platform?.graceDays ? `${platform.graceDays} more days` : 'a short grace period'}, then
            closes for your team until you pay. The owner can always sign in to pay.
          </li>
        </ul>

        <h2>Your information</h2>
        <ul>
          <li>
            Your restaurant’s records (menu, team, orders, customers, cash) belong to you. Relay
            keeps them separate from every other restaurant and uses them only to run the service
            for you.
          </li>
          <li>
            You can download a full copy at any time (Admin → Data & privacy). Nothing is deleted
            when a subscription ends or is paused.
          </li>
          <li>
            You are responsible for how your restaurant uses customers’ details. Your own privacy
            notice for customers and staff is on your restaurant’s sign-in page.
          </li>
        </ul>

        <h2>Using Relay</h2>
        <ul>
          <li>Keep your owner password safe; you are responsible for the accounts you create.</li>
          <li>
            Do not use Relay for anything unlawful or to harm others. We may pause a restaurant that
            does, or that asks us to; paused restaurants cannot sign in and nothing is deleted.
          </li>
          <li>
            We work to keep Relay available and correct, but cannot promise it will never be
            interrupted. Keep your own records of money received.
          </li>
          <li>We may update these terms; the current version is always on this page.</li>
        </ul>

        <h2>Contact</h2>
        <p>
          {contact ? (
            <>
              Questions, payments by arrangement, or to pause or close your restaurant:{' '}
              <b>{contact}</b>.
            </>
          ) : (
            <>Questions: contact Relay through the person who set up your restaurant.</>
          )}
        </p>
        <p className="muted small">Relay is software by Embiro Concepts.</p>
      </article>
    </main>
  );
}
