import { ArrowLeft } from 'lucide-react';
import { useSession } from '../lib/session';
import { BrandMark } from './BrandMark';

// The privacy notice and terms of use (/privacy), readable without signing
// in. The restaurant's name, contact and how long customer details are kept
// come from Admin → Data & privacy. A starting text: the owner should have it
// checked against the law that applies to them.
export function PrivacyPage() {
  const { appInfo, user } = useSession();
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
          {name} uses RelayEats to take and deliver orders and to account for the money. This page
          says what information that involves, why, who can see it and how long it is kept.
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
          Riders, cashiers and the owner have their own account. RelayEats records your name, phone
          number, username, shifts, the orders you take, deliver or handle, the cash you collect and
          hand over, and changes you make. This record exists to keep the money accountable and to
          settle disagreements fairly; the owner can see it. RelayEats does not track where you are.
        </p>

        <h2>Using RelayEats at work</h2>
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
          RelayEats stores its records with Back4App, a hosting service, on servers that may be
          outside your country. Connections are encrypted. Notifications on your phone go through
          your phone’s own notification service (Google or Apple).
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
        <p className="muted small">RelayEats is software by Embiro Concepts, used by {name}.</p>
      </article>
    </main>
  );
}
