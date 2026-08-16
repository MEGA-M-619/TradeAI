"use client";

import { useMemo, useState } from "react";
import { PageHeader, Button, Card, CardLink, Avatar, EmptyState, Input } from "@/components/ui";
import { CreateCustomerForm } from "@/components/CreateCustomerForm";
import styles from "./CustomersPageContent.module.css";

type CustomerListItem = {
  id: string;
  name: string;
  phone: string | null;
  email: string | null;
  _count: { jobs: number };
};

export function CustomersPageContent({
  orgId,
  customers,
}: {
  orgId: string;
  customers: CustomerListItem[];
}) {
  const [showForm, setShowForm] = useState(false);
  const [query, setQuery] = useState("");

  const visibleCustomers = useMemo(() => {
    const normalizedQuery = query.trim().toLowerCase();
    if (!normalizedQuery) return customers;
    return customers.filter(
      (customer) =>
        customer.name.toLowerCase().includes(normalizedQuery) ||
        customer.phone?.toLowerCase().includes(normalizedQuery) ||
        customer.email?.toLowerCase().includes(normalizedQuery),
    );
  }, [customers, query]);

  return (
    <div>
      <PageHeader
        title="Customers"
        actions={
          <Button variant="primary" onClick={() => setShowForm((v) => !v)}>
            {showForm ? "Cancel" : "+ New Customer"}
          </Button>
        }
      />

      {showForm && (
        <Card className={styles.formCard}>
          <h2 className={styles.formCardHeader}>New customer</h2>
          <CreateCustomerForm orgId={orgId} onCreated={() => setShowForm(false)} />
        </Card>
      )}

      {customers.length === 0 ? (
        <EmptyState
          title="No customers yet"
          description="Add a customer to start creating jobs for them."
        />
      ) : (
        <>
          <div className={styles.toolbar}>
            <Input
              placeholder="Search customers"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              aria-label="Search customers"
            />
          </div>

          {visibleCustomers.length === 0 ? (
            <EmptyState title="No customers match your search" />
          ) : (
            <div>
              {visibleCustomers.map((customer) => (
                <CardLink key={customer.id} href={`/orgs/${orgId}/customers/${customer.id}`}>
                  <div className={styles.customerCard}>
                    <Avatar name={customer.name} />
                    <div className={styles.customerInfo}>
                      <p className={styles.customerName}>{customer.name}</p>
                      {(customer.phone || customer.email) && (
                        <p className={styles.customerContact}>
                          {customer.phone ?? customer.email}
                        </p>
                      )}
                    </div>
                    <span className={styles.customerJobCount}>
                      {customer._count.jobs} {customer._count.jobs === 1 ? "job" : "jobs"}
                    </span>
                  </div>
                </CardLink>
              ))}
            </div>
          )}
        </>
      )}
    </div>
  );
}
