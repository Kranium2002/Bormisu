import { ReviewerName } from '../ReviewerName';

/**
 * The header's identity control. Placeholder of the M3 foundation: without sign-in it is the optional
 * reviewer name; the auth work turns it into the signed-in user's menu with SIGN OUT.
 */
export function UserMenu() {
  return <ReviewerName />;
}
