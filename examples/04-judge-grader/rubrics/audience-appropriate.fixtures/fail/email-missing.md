Your deliverability issue is caused by a missing SPF include for our
outbound mail relay. Without it, receiving MTAs can't validate that our
servers are authorized senders for your domain, so DMARC alignment fails
and messages get soft-rejected or routed to spam. I've updated your SPF
TXT record to include our sending range. Propagation of the DNS change
should complete within a couple hours, after which SPF alignment should
pass and deliverability should normalize.
