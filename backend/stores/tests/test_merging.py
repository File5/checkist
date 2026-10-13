"""Склейка магазинов (``stores.merging``), группы модели (``stores.grouping``) и команда ``store_merges``.

Настоящая модель не вызывается: fake либо подменённый провайдер. Названия и данные вымышленные.
"""
import json
from datetime import date, datetime, timezone as dt_timezone
from decimal import Decimal
from io import StringIO
from unittest.mock import Mock, patch

from django.core.management import CommandError, call_command
from django.test import SimpleTestCase, TestCase, override_settings, tag

from catalog.models import Category
from receipts import manual
from receipts.models import Receipt
from receipts.ownership import local_user
from recognition.providers.base import ProviderError
from stores import grouping, merging
from stores.models import StoreMerge, StoreMergeSuggestion


class NameTests(SimpleTestCase):
    def test_name_key_drops_case_punctuation_legal_forms_and_statement_tails(self):
        self.assertEqual(merging.name_key("CLAUDE.AI SUBSCRIPTION"), "claude ai")
        self.assertEqual(merging.name_key("ТОО «Small»"), "small")
        self.assertEqual(merging.name_key("MAGNUM*ALMATY"), "magnum almaty")
        self.assertEqual(merging.name_key("Netflix SUBSCR 0412"), "netflix 0412")
        self.assertEqual(merging.name_key("Ёлка"), "елка")

    def test_similarity(self):
        key = merging.name_key
        self.assertEqual(merging.similarity(key("Small"), key("ТОО Small")), 1.0)
        self.assertEqual(merging.similarity(key("MAGNUM"), key("MAGNUM*ALMATY")), 0.9)
        self.assertGreaterEqual(merging.similarity(key("Europharma"), key("Europharm")), merging.SIMILAR_RATIO)
        for first, second in [("Yandex Go", "YANDEX.EDA"), ("Аптека Europharma", "Аптека Биосфера"),
                              ("Магазин у дома", "Кофейня у дома"), ("", "Small")]:
            self.assertEqual(merging.similarity(key(first), key(second)), 0.0, (first, second))

    def test_similar_pairs_are_strong_first(self):
        names = {1: "MAGNUM", 2: "MAGNUM*ALMATY", 3: "Small", 4: "ТОО Small", 5: "Yandex Go", 6: "YANDEX.EDA"}
        self.assertEqual(merging.similar_pairs(names), [(3, 4), (1, 2)])


class Spends:
    @classmethod
    def setUpTestData(cls):
        super().setUpTestData()
        cls.owner = local_user()
        cls.subs = Category.objects.create(name="Демо-подписки")

    def spend(self, store_name, total="225", **fields):
        return manual.create(self.owner, {"total": total, "currency": "KZT", "category": self.subs.pk,
                                          "store_name": store_name, "purchased_on": "2026-10-01", **fields})


@tag("integration")
class MergeTests(Spends, TestCase):
    def test_merge_moves_receipts_keeps_the_name_as_a_spelling_and_reverts(self):
        claude = self.spend("CLAUDE.AI SUBSCRIPTION").store
        anthropic_spend = self.spend("Anthropic Claude")
        anthropic = anthropic_spend.store
        [entry] = merging.merge(claude.pk, [anthropic.pk], actor=self.owner)
        anthropic.refresh_from_db()
        self.assertEqual(anthropic.merged_into, claude)
        self.assertEqual(Receipt.objects.get(pk=anthropic_spend.pk).store, claude)
        self.assertEqual((entry.store, entry.merged, entry.receipt_ids, entry.alias_ids, entry.created_by),
                         (claude, anthropic, [anthropic_spend.pk], [], self.owner))
        # The single name → store entry answers the main store for a spelling.
        self.assertEqual(manual.find_or_create_store("anthropic claude", "USD"), claude)
        self.assertEqual(self.spend("ANTHROPIC CLAUDE").store, claude)
        self.assertEqual(merging.aliases([claude.pk]), {claude.pk: ["Anthropic Claude"]})

        merging.revert(entry.pk)
        anthropic.refresh_from_db()
        self.assertIsNone(anthropic.merged_into)
        self.assertEqual(Receipt.objects.get(pk=anthropic_spend.pk).store, anthropic)
        self.assertIsNotNone(StoreMerge.objects.get().reverted_at)
        self.assertEqual(manual.find_or_create_store("Anthropic Claude", "KZT"), anthropic)
        with self.assertRaises(merging.MergeInvalid):
            merging.revert(entry.pk)

    def test_merging_a_main_store_moves_its_spellings_and_revert_restores_them(self):
        first, second, third = (self.spend(name).store for name in ("Small", "ТОО Small", "SMALL*ALMATY"))
        merging.merge(second.pk, [third.pk])
        [entry] = merging.merge(first.pk, [second.pk])
        third.refresh_from_db()
        self.assertEqual(third.merged_into, first)  # always straight to the main one
        self.assertEqual(entry.alias_ids, [third.pk])
        self.assertEqual(Receipt.objects.filter(store=first).count(), 3)
        self.assertEqual(manual.find_or_create_store("SMALL*ALMATY", "KZT"), first)
        merging.revert(entry.pk)
        third.refresh_from_db()
        self.assertEqual(third.merged_into, second)
        self.assertEqual(Receipt.objects.filter(store=second).count(), 2)

    def test_refusals_change_nothing(self):
        first, second = self.spend("Демо А").store, self.spend("Демо Б").store
        merging.merge(first.pk, [second.pk])
        cases = [
            ((999999, [first.pk]), {"store": "unknown"}),
            ((second.pk, [first.pk]), {"store": "merged"}),
            ((first.pk, []), {"merged": "required"}),
            ((first.pk, [first.pk]), {"merged": "same"}),
            ((first.pk, [999999]), {"merged": "unknown"}),
            ((first.pk, [second.pk]), {"merged": "merged"}),
        ]
        for arguments, fields in cases:
            with self.subTest(arguments=arguments), self.assertRaises(merging.MergeInvalid) as caught:
                merging.merge(*arguments)
            self.assertEqual(caught.exception.fields, fields)
        self.assertEqual(StoreMerge.objects.count(), 1)

    def test_two_equal_photo_receipts_of_one_person_are_a_conflict(self):
        first, second = self.spend("Демо А").store, self.spend("Демо Б").store
        moment = datetime(2026, 10, 1, 9, tzinfo=dt_timezone.utc)
        for store in (first, second):
            Receipt.objects.create(owner=self.owner, store=store, currency_id="KZT", operation="sale",
                                   purchased_at=moment, purchased_on=date(2026, 10, 1), total=Decimal("500.00"))
        with self.assertRaises(merging.MergeConflict):
            merging.merge(first.pk, [second.pk])
        second.refresh_from_db()
        self.assertIsNone(second.merged_into)
        self.assertEqual(Receipt.objects.filter(store=second).count(), 2)
        self.assertFalse(StoreMerge.objects.exists())


@tag("integration")
class MergeMovesRecurringTests(Spends, TestCase):
    def test_templates_and_dismissed_suggestions_follow_the_main_store(self):
        from recurring.models import DismissedSuggestion, RecurringPayment

        claude = self.spend("CLAUDE.AI SUBSCRIPTION").store
        anthropic = self.spend("Anthropic Claude").store
        owner = {"user": self.owner, "category": self.subs, "currency_id": "KZT"}
        template = RecurringPayment.objects.create(name="Claude", store=anthropic, amount="225", due_day=12, **owner)
        moved = DismissedSuggestion.objects.create(store=anthropic, **owner)
        merging.merge(claude.pk, [anthropic.pk], actor=self.owner)
        template.refresh_from_db()
        self.assertEqual(template.store, claude)
        self.assertEqual(DismissedSuggestion.objects.get(pk=moved.pk).store, claude)

    def test_a_dismissal_the_main_store_already_has_is_dropped(self):
        from recurring.models import DismissedSuggestion

        claude = self.spend("CLAUDE.AI SUBSCRIPTION").store
        anthropic = self.spend("Anthropic Claude").store
        owner = {"user": self.owner, "category": self.subs, "currency_id": "KZT"}
        DismissedSuggestion.objects.create(store=claude, **owner)
        DismissedSuggestion.objects.create(store=anthropic, **owner)
        merging.merge(claude.pk, [anthropic.pk], actor=self.owner)
        self.assertEqual(list(DismissedSuggestion.objects.values_list("store_id", flat=True)), [claude.pk])

@tag("integration")
class SuggestionTests(TestCase):
    names = {1: "MAGNUM", 2: "MAGNUM*ALMATY", 3: "Small", 4: "ТОО Small", 5: "Демо кафе"}
    counts = {1: 9, 2: 2, 3: 1, 4: 5, 5: 3}

    def test_similar_pairs_and_model_groups_most_used_first(self):
        StoreMergeSuggestion.objects.create(store_ids=[2, 5, 77], source="model")  # 77 is not of the family
        self.assertEqual(merging.suggestions(self.counts, self.names), [
            {"source": "model", "stores": [5, 2]},
            {"source": "similar", "stores": [4, 3]},
            {"source": "similar", "stores": [1, 2]},
        ])

    def test_dismissed_group_and_pairs_inside_it_are_not_offered(self):
        StoreMergeSuggestion.objects.create(store_ids=[1, 2, 5], source="model")
        merging.dismiss([5, 2, 1])
        merging.dismiss([3, 4])
        merging.dismiss([4, 3])  # again: nothing new
        self.assertEqual(merging.suggestions(self.counts, self.names), [])
        self.assertEqual(StoreMergeSuggestion.objects.filter(status="dismissed").count(), 2)


@tag("integration")
class GroupingTests(Spends, TestCase):
    def setUp(self):
        self.magnum = self.spend("MAGNUM").store
        self.magnum_city = self.spend("MAGNUM*ALMATY").store
        self.other = self.spend("Демо кафе").store

    def test_fake_groups_similar_names_and_keeps_only_new_groups(self):
        groups, saved = grouping.suggest(grouping.FakeGrouper(), dry_run=True)
        self.assertEqual((groups, saved), ([[self.magnum.pk, self.magnum_city.pk]], 0))
        self.assertFalse(StoreMergeSuggestion.objects.exists())
        self.assertEqual(grouping.suggest(grouping.FakeGrouper())[1], 1)
        self.assertEqual(grouping.suggest(grouping.FakeGrouper())[1], 0)
        self.assertEqual(list(StoreMergeSuggestion.objects.values_list("store_ids", "source")),
                         [([self.magnum.pk, self.magnum_city.pk], "model")])

    def test_answer_is_checked(self):
        payload = {"stores": [{"id": pk, "name": "x"} for pk in (1, 2, 3, 4)]}
        self.assertEqual(grouping.groups_from_output({"groups": [[2, 1, 1], [1, 4], [3, 4], [5, 3], [2, 2]]}, payload),
                         [[1, 2], [3, 4]])
        for bad in ({"groups": [[1, "2"]]}, {"groups": [[3]]}, {"groups": [[1, 2]], "extra": 1}, {}, "groups"):
            with self.subTest(bad=bad), self.assertRaises(grouping.GroupingOutputError):
                grouping.groups_from_output(bad, payload)

    def test_codex_grouper_sends_the_stores_after_the_marker(self):
        provider = Mock()
        provider.run_text.return_value = {"groups": [[self.magnum.pk, self.magnum_city.pk]]}
        groups, saved = grouping.suggest(grouping.CodexGrouper(provider))
        self.assertEqual(saved, 1)
        prompt = provider.run_text.call_args.kwargs["prompt"]
        sent = json.loads(prompt.split(grouping.INPUT_MARKER, 1)[1])
        self.assertEqual({item["name"] for item in sent["stores"]}, {"MAGNUM", "MAGNUM*ALMATY", "Демо кафе"})
        self.assertEqual(provider.run_text.call_args.kwargs["schema"], grouping.SCHEMA_PATH)

    @override_settings(RECEIPT_OCR_PROVIDER="codex_cli", RECEIPT_OCR_CODEX_EXECUTABLE="nonexistent-checkist-codex")
    def test_command_fails_without_codex_and_saves_nothing(self):
        with patch("recognition.process_supervisor.ProcessSupervisor.run") as launch, \
                self.assertRaisesMessage(CommandError, "The model call failed: configuration_error"):
            call_command("store_merges", "suggest", stdout=StringIO())
        launch.assert_not_called()
        self.assertFalse(StoreMergeSuggestion.objects.exists())

    def test_command_suggest_list_and_revert(self):
        out = StringIO()
        call_command("store_merges", "suggest", "--dry-run", stdout=out)
        self.assertEqual(json.loads(out.getvalue()), {"dry_run": True, "groups": [[self.magnum.pk, self.magnum_city.pk]], "saved": 0})
        [entry] = merging.merge(self.magnum.pk, [self.magnum_city.pk])
        out = StringIO()
        call_command("store_merges", "list", stdout=out)
        self.assertEqual([(row["id"], row["receipts"], row["reverted_at"]) for row in json.loads(out.getvalue())],
                         [(entry.pk, 1, None)])
        call_command("store_merges", "revert", str(entry.pk), stdout=StringIO())
        self.magnum_city.refresh_from_db()
        self.assertIsNone(self.magnum_city.merged_into)
        with self.assertRaisesMessage(CommandError, "already reverted"):
            call_command("store_merges", "revert", str(entry.pk), stdout=StringIO())
        with self.assertRaisesMessage(CommandError, "An entry id"):
            call_command("store_merges", "revert", stdout=StringIO())

    def test_provider_failure_is_reported(self):
        grouper = Mock()
        grouper.group.side_effect = ProviderError("timeout")
        with self.assertRaises(ProviderError):
            grouping.suggest(grouper)
        self.assertFalse(StoreMergeSuggestion.objects.exists())
