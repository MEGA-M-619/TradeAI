import { EmptyState, LinkButton } from "@/components/ui";
import styles from "./not-found.module.css";

export default function NotFound() {
  return (
    <div className={styles.wrap}>
      <EmptyState
        title="Page not found"
        description="The page you're looking for doesn't exist or you may not have access to it."
        action={<LinkButton href="/orgs">Back to organizations</LinkButton>}
      />
    </div>
  );
}
