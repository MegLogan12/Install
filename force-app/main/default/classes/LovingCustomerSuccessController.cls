public with sharing class LovingCustomerSuccessController {

    // ── Dashboard KPIs ──────────────────────────────────────────────────────
    @AuraEnabled(cacheable=true)
    public static Map<String, Object> getDashboardKPIs() {
        Map<String, Object> result = new Map<String, Object>();
        try {
            result.put('openCases',       [SELECT COUNT() FROM Case WHERE IsClosed = false WITH SECURITY_ENFORCED]);
            result.put('newToday',        [SELECT COUNT() FROM Case WHERE CreatedDate = TODAY WITH SECURITY_ENFORCED]);
            result.put('openWorkOrders',  [SELECT COUNT() FROM WorkOrder WHERE Status NOT IN ('Completed','Cannot Complete') WITH SECURITY_ENFORCED]);
            result.put('siteVisitsWeek',  [SELECT COUNT() FROM ServiceAppointment WHERE SchedStartTime = THIS_WEEK WITH SECURITY_ENFORCED]);
        } catch (Exception e) {
            result.put('error', e.getMessage());
        }

        try {
            result.put('pendingApprovals', [SELECT COUNT() FROM ProcessInstanceWorkitem WHERE Actor.Id = :UserInfo.getUserId()]);
        } catch (Exception e) {
            result.put('pendingApprovals', 0);
        }

        result.put('overdueCases', [
            SELECT COUNT() FROM Case
            WHERE IsClosed = false
            AND CreatedDate < LAST_N_DAYS:7
            WITH SECURITY_ENFORCED
        ]);

        return result;
    }

    // ── Cases ───────────────────────────────────────────────────────────────
    @AuraEnabled(cacheable=true)
    public static List<Case> getCases(String typeFilter, Integer maxRows) {
        if (maxRows == null || maxRows <= 0 || maxRows > 200) maxRows = 50;
        if (String.isNotBlank(typeFilter) && typeFilter != 'All') {
            return [
                SELECT Id, CaseNumber, Subject, Status, Priority, Type,
                       Account.Name, Contact.Name, CreatedDate, LastModifiedDate
                FROM Case
                WHERE IsClosed = false AND Type = :typeFilter
                WITH SECURITY_ENFORCED
                ORDER BY LastModifiedDate DESC
                LIMIT :maxRows
            ];
        }
        return [
            SELECT Id, CaseNumber, Subject, Status, Priority, Type,
                   Account.Name, Contact.Name, CreatedDate, LastModifiedDate
            FROM Case
            WHERE IsClosed = false
            WITH SECURITY_ENFORCED
            ORDER BY LastModifiedDate DESC
            LIMIT :maxRows
        ];
    }

    @AuraEnabled(cacheable=true)
    public static List<Case> getUrgentCases() {
        return [
            SELECT Id, CaseNumber, Subject, Status, Priority, Type,
                   Account.Name, Contact.Name, CreatedDate, LastModifiedDate
            FROM Case
            WHERE IsClosed = false AND Priority = 'High'
            WITH SECURITY_ENFORCED
            ORDER BY CreatedDate ASC
            LIMIT 15
        ];
    }

    @AuraEnabled
    public static Id createCase(Map<String, Object> fields) {
        Case c = new Case();
        if (fields.containsKey('Subject'))     c.Subject     = (String) fields.get('Subject');
        if (fields.containsKey('Type'))        c.Type        = (String) fields.get('Type');
        if (fields.containsKey('Priority'))    c.Priority    = (String) fields.get('Priority');
        if (fields.containsKey('AccountId'))   c.AccountId   = (Id)     fields.get('AccountId');
        if (fields.containsKey('ContactId'))   c.ContactId   = (Id)     fields.get('ContactId');
        if (fields.containsKey('Description')) c.Description = (String) fields.get('Description');
        insert c;
        return c.Id;
    }

    // ── Work Orders ─────────────────────────────────────────────────────────
    @AuraEnabled(cacheable=true)
    public static List<WorkOrder> getWorkOrders(String statusFilter, Integer maxRows) {
        if (maxRows == null || maxRows <= 0 || maxRows > 200) maxRows = 50;
        if (String.isNotBlank(statusFilter) && statusFilter != 'All') {
            return [
                SELECT Id, WorkOrderNumber, Subject, Status, Priority,
                       Account.Name, StartDate, EndDate, CreatedDate
                FROM WorkOrder
                WHERE Status = :statusFilter
                WITH SECURITY_ENFORCED
                ORDER BY CreatedDate DESC
                LIMIT :maxRows
            ];
        }
        return [
            SELECT Id, WorkOrderNumber, Subject, Status, Priority,
                   Account.Name, StartDate, EndDate, CreatedDate
            FROM WorkOrder
            WHERE Status NOT IN ('Completed','Cannot Complete')
            WITH SECURITY_ENFORCED
            ORDER BY CreatedDate DESC
            LIMIT :maxRows
        ];
    }

    // ── Service Appointments ────────────────────────────────────────────────
    @AuraEnabled(cacheable=true)
    public static List<ServiceAppointment> getServiceAppointments(String statusFilter, Integer maxRows) {
        if (maxRows == null || maxRows <= 0 || maxRows > 200) maxRows = 50;
        if (String.isNotBlank(statusFilter) && statusFilter != 'All') {
            return [
                SELECT Id, AppointmentNumber, Subject, Status,
                       SchedStartTime, SchedEndTime, Account.Name
                FROM ServiceAppointment
                WHERE Status = :statusFilter
                WITH SECURITY_ENFORCED
                ORDER BY SchedStartTime ASC
                LIMIT :maxRows
            ];
        }
        return [
            SELECT Id, AppointmentNumber, Subject, Status,
                   SchedStartTime, SchedEndTime, Account.Name
            FROM ServiceAppointment
            WHERE Status NOT IN ('Completed','Cannot Complete')
            WITH SECURITY_ENFORCED
            ORDER BY SchedStartTime ASC
            LIMIT :maxRows
        ];
    }

    // ── Omni-Channel Work ───────────────────────────────────────────────────
    @AuraEnabled(cacheable=true)
    public static List<SObject> getOmniWork() {
        try {
            return [
                SELECT Id, WorkItemId, Status, CreatedDate
                FROM AgentWork
                WHERE UserId = :UserInfo.getUserId()
                AND Status IN ('Opened','Assigned')
                ORDER BY CreatedDate DESC
                LIMIT 25
            ];
        } catch (Exception e) {
            return new List<SObject>();
        }
    }

    // ── Approvals ───────────────────────────────────────────────────────────
    @AuraEnabled(cacheable=true)
    public static List<ProcessInstanceWorkitem> getPendingApprovals() {
        try {
            return [
                SELECT Id, ElapsedTimeInDays,
                       ProcessInstance.TargetObjectId,
                       ProcessInstance.Status,
                       ProcessInstance.SubmittedBy.Name,
                       CreatedDate
                FROM ProcessInstanceWorkitem
                WHERE Actor.Id = :UserInfo.getUserId()
                ORDER BY CreatedDate ASC
                LIMIT 50
            ];
        } catch (Exception e) {
            return new List<ProcessInstanceWorkitem>();
        }
    }

    // ── Quotes ──────────────────────────────────────────────────────────────
    @AuraEnabled(cacheable=true)
    public static List<Quote> getQuotes(Integer maxRows) {
        if (maxRows == null || maxRows <= 0 || maxRows > 200) maxRows = 50;
        return [
            SELECT Id, Name, Status, GrandTotal, ExpirationDate,
                   Account.Name, OpportunityId
            FROM Quote
            WITH SECURITY_ENFORCED
            ORDER BY LastModifiedDate DESC
            LIMIT :maxRows
        ];
    }

    @AuraEnabled(cacheable=true)
    public static List<QuoteLineItem> getQuoteLineItems(Id quoteId) {
        return [
            SELECT Id, Quantity, UnitPrice, TotalPrice,
                   Product2.Name, Product2.ProductCode, Description
            FROM QuoteLineItem
            WHERE QuoteId = :quoteId
            WITH SECURITY_ENFORCED
            ORDER BY SortOrder ASC NULLS LAST
        ];
    }

    // ── Builder Accounts ────────────────────────────────────────────────────
    @AuraEnabled(cacheable=true)
    public static List<Account> getBuilderAccounts(Integer maxRows) {
        if (maxRows == null || maxRows <= 0 || maxRows > 100) maxRows = 25;
        return [
            SELECT Id, Name, Phone, BillingCity, BillingState, Owner.Name
            FROM Account
            WHERE Id IN (
                SELECT AccountId FROM Case
                WHERE AccountId != null AND IsClosed = false
            )
            WITH SECURITY_ENFORCED
            ORDER BY Name ASC
            LIMIT :maxRows
        ];
    }

    @AuraEnabled(cacheable=true)
    public static Map<String, Object> getBuilderSummary(Id accountId) {
        Map<String, Object> result = new Map<String, Object>();
        if (accountId == null) return result;
        result.put('openCases',      [SELECT COUNT() FROM Case       WHERE AccountId = :accountId AND IsClosed = false WITH SECURITY_ENFORCED]);
        result.put('openWorkOrders', [SELECT COUNT() FROM WorkOrder  WHERE AccountId = :accountId AND Status NOT IN ('Completed','Cannot Complete') WITH SECURITY_ENFORCED]);
        result.put('openQuotes',     [SELECT COUNT() FROM Quote      WHERE AccountId = :accountId AND Status NOT IN ('Declined','Cancelled') WITH SECURITY_ENFORCED]);
        return result;
    }

    // ── Knowledge ───────────────────────────────────────────────────────────
    @AuraEnabled(cacheable=true)
    public static List<SObject> getKnowledgeArticles(String keywords) {
        try {
            String likeVal = String.isNotBlank(keywords) ? '%' + String.escapeSingleQuotes(keywords) + '%' : '%';
            String soql = 'SELECT Id, Title, Summary, LastPublishedDate'
                        + ' FROM KnowledgeArticleVersion'
                        + ' WHERE PublishStatus = \'Online\' AND Language = \'en_US\''
                        + ' AND (Title LIKE :likeVal OR Summary LIKE :likeVal)'
                        + ' ORDER BY LastPublishedDate DESC LIMIT 20';
            return Database.query(soql);
        } catch (Exception e) {
            return new List<SObject>();
        }
    }
}
