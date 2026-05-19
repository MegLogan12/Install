@IsTest
private class LovingCustomerSuccessControllerTest {

    @TestSetup
    static void makeData() {
        Account acct = new Account(Name = 'Test Builder Co', BillingCity = 'Charlotte', BillingState = 'NC');
        insert acct;

        Contact ct = new Contact(LastName = 'Homeowner', AccountId = acct.Id);
        insert ct;

        List<Case> cases = new List<Case>{
            new Case(Subject = 'Urgent Warranty Issue', Status = 'New', Priority = 'High',
                     Type = 'Warranty', AccountId = acct.Id, ContactId = ct.Id),
            new Case(Subject = 'EPO Change Request', Status = 'In Progress', Priority = 'Medium',
                     Type = 'EPO', AccountId = acct.Id),
            new Case(Subject = 'Same Day Fix', Status = 'New', Priority = 'High',
                     Type = 'Same-Day', AccountId = acct.Id)
        };
        insert cases;

        WorkOrder wo = new WorkOrder(Subject = 'Site Visit - Charlotte', Status = 'New',
                                     AccountId = acct.Id);
        insert wo;

        ServiceAppointment sa = new ServiceAppointment(
            ParentRecordId = wo.Id,
            Status = 'Scheduled',
            SchedStartTime = System.now().addDays(1),
            SchedEndTime   = System.now().addDays(1).addHours(2)
        );
        insert sa;

        Opportunity opp = new Opportunity(Name = 'Test Opp', StageName = 'Proposal/Price Quote',
                                          CloseDate = Date.today().addDays(30), AccountId = acct.Id);
        insert opp;

        Pricebook2 pb = [SELECT Id FROM Pricebook2 WHERE IsStandard = true LIMIT 1];
        Quote q = new Quote(Name = 'Test Quote', OpportunityId = opp.Id, Pricebook2Id = pb.Id,
                            Status = 'Draft', ExpirationDate = Date.today().addDays(30));
        insert q;
    }

    // ── getDashboardKPIs ────────────────────────────────────────────────────
    @IsTest
    static void testGetDashboardKPIs() {
        Test.startTest();
        Map<String, Object> kpis = LovingCustomerSuccessController.getDashboardKPIs();
        Test.stopTest();

        System.assertNotEquals(null, kpis, 'KPIs map should not be null');
        System.assert(kpis.containsKey('openCases'), 'Should contain openCases key');
        System.assert((Integer) kpis.get('openCases') >= 3, 'Should have at least 3 open cases');
        System.assert(kpis.containsKey('openWorkOrders'), 'Should contain openWorkOrders key');
    }

    // ── getCases ────────────────────────────────────────────────────────────
    @IsTest
    static void testGetCasesAll() {
        Test.startTest();
        List<Case> results = LovingCustomerSuccessController.getCases('All', 50);
        Test.stopTest();
        System.assert(results.size() >= 3, 'Should return at least 3 cases');
    }

    @IsTest
    static void testGetCasesByType() {
        Test.startTest();
        List<Case> warrantyResults = LovingCustomerSuccessController.getCases('Warranty', 50);
        List<Case> epoResults      = LovingCustomerSuccessController.getCases('EPO', 50);
        Test.stopTest();
        System.assertEquals(1, warrantyResults.size(), 'Should return 1 Warranty case');
        System.assertEquals(1, epoResults.size(), 'Should return 1 EPO case');
    }

    @IsTest
    static void testGetCasesNullParams() {
        Test.startTest();
        List<Case> results = LovingCustomerSuccessController.getCases(null, null);
        Test.stopTest();
        System.assertNotEquals(null, results, 'Should not throw on null params');
    }

    // ── getUrgentCases ──────────────────────────────────────────────────────
    @IsTest
    static void testGetUrgentCases() {
        Test.startTest();
        List<Case> results = LovingCustomerSuccessController.getUrgentCases();
        Test.stopTest();
        System.assert(results.size() >= 2, 'Should return High priority cases');
        for (Case c : results) {
            System.assertEquals('High', c.Priority, 'All returned cases should be High priority');
        }
    }

    // ── createCase ──────────────────────────────────────────────────────────
    @IsTest
    static void testCreateCase() {
        Account acct = [SELECT Id FROM Account LIMIT 1];
        Map<String, Object> fields = new Map<String, Object>{
            'Subject'  => 'Test Created Case',
            'Type'     => 'Warranty',
            'Priority' => 'Medium',
            'AccountId' => acct.Id
        };
        Test.startTest();
        Id newCaseId = LovingCustomerSuccessController.createCase(fields);
        Test.stopTest();
        System.assertNotEquals(null, newCaseId, 'Created case ID should not be null');
        Case c = [SELECT Subject, Type FROM Case WHERE Id = :newCaseId];
        System.assertEquals('Test Created Case', c.Subject);
        System.assertEquals('Warranty', c.Type);
    }

    // ── getWorkOrders ───────────────────────────────────────────────────────
    @IsTest
    static void testGetWorkOrders() {
        Test.startTest();
        List<WorkOrder> results = LovingCustomerSuccessController.getWorkOrders('All', 50);
        Test.stopTest();
        System.assert(results.size() >= 1, 'Should return at least 1 work order');
    }

    @IsTest
    static void testGetWorkOrdersByStatus() {
        Test.startTest();
        List<WorkOrder> newWOs = LovingCustomerSuccessController.getWorkOrders('New', 50);
        Test.stopTest();
        System.assertEquals(1, newWOs.size(), 'Should return 1 New work order');
    }

    // ── getServiceAppointments ──────────────────────────────────────────────
    @IsTest
    static void testGetServiceAppointments() {
        Test.startTest();
        List<ServiceAppointment> results = LovingCustomerSuccessController.getServiceAppointments('All', 50);
        Test.stopTest();
        System.assert(results.size() >= 1, 'Should return at least 1 service appointment');
    }

    // ── getOmniWork ─────────────────────────────────────────────────────────
    @IsTest
    static void testGetOmniWork() {
        Test.startTest();
        List<SObject> results = LovingCustomerSuccessController.getOmniWork();
        Test.stopTest();
        // Returns empty list when Omni not enabled in test org — should not throw
        System.assertNotEquals(null, results, 'Should return a list (possibly empty) not null');
    }

    // ── getPendingApprovals ─────────────────────────────────────────────────
    @IsTest
    static void testGetPendingApprovals() {
        Test.startTest();
        List<ProcessInstanceWorkitem> results = LovingCustomerSuccessController.getPendingApprovals();
        Test.stopTest();
        System.assertNotEquals(null, results, 'Should return a list not null');
    }

    // ── getQuotes ───────────────────────────────────────────────────────────
    @IsTest
    static void testGetQuotes() {
        Test.startTest();
        List<Quote> results = LovingCustomerSuccessController.getQuotes(50);
        Test.stopTest();
        System.assert(results.size() >= 1, 'Should return at least 1 quote');
    }

    @IsTest
    static void testGetQuoteLineItems() {
        Quote q = [SELECT Id FROM Quote LIMIT 1];
        Test.startTest();
        List<QuoteLineItem> items = LovingCustomerSuccessController.getQuoteLineItems(q.Id);
        Test.stopTest();
        System.assertNotEquals(null, items, 'Should return list not null');
    }

    // ── getBuilderAccounts ──────────────────────────────────────────────────
    @IsTest
    static void testGetBuilderAccounts() {
        Test.startTest();
        List<Account> results = LovingCustomerSuccessController.getBuilderAccounts(25);
        Test.stopTest();
        System.assert(results.size() >= 1, 'Should return accounts that have open cases');
    }

    // ── getBuilderSummary ───────────────────────────────────────────────────
    @IsTest
    static void testGetBuilderSummary() {
        Account acct = [SELECT Id FROM Account LIMIT 1];
        Test.startTest();
        Map<String, Object> summary = LovingCustomerSuccessController.getBuilderSummary(acct.Id);
        Test.stopTest();
        System.assert(summary.containsKey('openCases'), 'Summary should contain openCases');
        System.assert((Integer) summary.get('openCases') >= 3);
    }

    @IsTest
    static void testGetBuilderSummaryNullId() {
        Test.startTest();
        Map<String, Object> summary = LovingCustomerSuccessController.getBuilderSummary(null);
        Test.stopTest();
        System.assertNotEquals(null, summary, 'Should return empty map not null');
        System.assert(summary.isEmpty(), 'Should be empty for null accountId');
    }

    // ── getKnowledgeArticles ────────────────────────────────────────────────
    @IsTest
    static void testGetKnowledgeArticles() {
        Test.startTest();
        List<SObject> results = LovingCustomerSuccessController.getKnowledgeArticles('warranty');
        Test.stopTest();
        // Returns empty list when Knowledge not enabled — should not throw
        System.assertNotEquals(null, results, 'Should return list not null');
    }

    @IsTest
    static void testGetKnowledgeArticlesBlankKeyword() {
        Test.startTest();
        List<SObject> results = LovingCustomerSuccessController.getKnowledgeArticles('');
        Test.stopTest();
        System.assertNotEquals(null, results);
    }
}
