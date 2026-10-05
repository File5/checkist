import random
from decimal import Decimal

from django.test import SimpleTestCase

from merges import demo
from merges.detection import (
    Candidate, compact, facts_conflict, find_edges, find_groups, levenshtein, name_distance, numbers,
    target_key, tolerance,
)


def demo_candidates():
    return [
        Candidate(
            id=number, name=spec["name"], merchants=frozenset({spec["merchant"]}), gtin=spec.get("gtin", ""),
            brand=spec.get("brand"), package=spec.get("package"), service_generic="generic" not in spec,
        )
        for number, spec in enumerate(demo.PRODUCTS, 1)
    ]


def candidate(number, name, **facts):
    facts.setdefault("merchants", frozenset({1}))
    return Candidate(id=number, name=name, **facts)


class NormalizationTests(SimpleTestCase):
    def test_compact_drops_case_diacritics_spaces_and_punctuation(self):
        self.assertEqual(compact("BürgerSchwä.Maultas."), "burgerschwamaultas")
        self.assertEqual(compact("Geflügelfilet roulade"), compact("Geflügelfiletroulade"))
        self.assertEqual(compact("Steinhof.PizzaSpezial"), compact("steinhof pizzaspezial"))
        self.assertEqual(compact("Ёлочный Йогурт 2,5%"), "елочныииогурт25")
        self.assertEqual(compact("Straße"), "strasse")
        self.assertEqual(compact(" .,-% "), "")
        self.assertEqual(compact(None), "")

    def test_numbers_keep_order_and_unify_the_decimal_separator(self):
        self.assertEqual(numbers("GQ EgSB H-Milch 1,5%"), ("1.5",))
        self.assertEqual(numbers("Eier 10er Freiland"), ("10",))
        self.assertEqual(numbers("Вода 0.5л 6 шт"), ("0.5", "6"))
        self.assertEqual(numbers("Pizza Hot Dog"), ())
        self.assertNotEqual(numbers("Молоко 2,5%"), numbers("Молоко 25%"))

    def test_levenshtein(self):
        self.assertEqual(levenshtein("", ""), 0)
        self.assertEqual(levenshtein("abc", ""), 3)
        self.assertEqual(levenshtein("kitten", "sitting"), 3)
        self.assertEqual(levenshtein("steinhof", "steinof"), 1)
        self.assertEqual(levenshtein("abc", "acb"), 2)
        self.assertEqual(levenshtein("sitting", "kitten"), levenshtein("kitten", "sitting"))

    def test_tolerance_by_the_shorter_name(self):
        self.assertEqual([tolerance(length) for length in (0, 5, 6, 11, 12, 40)], [0, 0, 1, 1, 2, 2])


class SignalTests(SimpleTestCase):
    def test_no_shared_merchant_no_candidate(self):
        first = candidate(1, "Landbrot geschnitten", merchants=frozenset({1}))
        second = candidate(2, "Landbrot geschnitten.", merchants=frozenset({2}))
        self.assertIsNone(name_distance(first, second))
        self.assertEqual(name_distance(first, candidate(2, "Landbrot geschnitten.", merchants=frozenset({1, 2}))), 0)

    def test_product_without_aliases_is_never_a_candidate(self):
        self.assertIsNone(name_distance(
            candidate(1, "Landbrot geschnitten", merchants=frozenset()),
            candidate(2, "Landbrot geschnitten.", merchants=frozenset()),
        ))

    def test_numeric_signatures_must_match(self):
        for first, second in (
            ("Demo Joghurt 1,5%", "Demo Joghurt 3,5%"), ("Demo Wasser 0.5l", "Demo Wasser 5l"),
            ("Eier 10er Freiland", "Eier 6er Freiland"), ("Молоко 2,5%", "Молоко 25%"),
        ):
            with self.subTest(first=first):
                self.assertIsNone(name_distance(candidate(1, first), candidate(2, second)))

    def test_distance_is_bounded_by_the_shorter_name(self):
        self.assertIsNone(name_distance(candidate(1, "Bio Ei"), candidate(2, "Bio Eis")))  # n = 5 → 0
        self.assertEqual(name_distance(candidate(1, "Bio Eier M"), candidate(2, "Bio Eier L")), 1)  # n = 8 → 1
        self.assertIsNone(name_distance(candidate(1, "Bio Eier MM"), candidate(2, "Bio Eier LL")))
        self.assertEqual(name_distance(candidate(1, "GO EgSB H-Milch 1,5%"), candidate(2, "GO FoSB H-Milch 1,5%")), 2)
        self.assertIsNone(name_distance(candidate(1, " .,- "), candidate(2, "...")))

    def test_false_pair_is_far_beyond_the_tolerance(self):
        first, second = (compact(name) for name in demo.FALSE_PAIR)
        self.assertEqual(levenshtein(first, second), 5)
        self.assertIsNone(name_distance(candidate(1, demo.FALSE_PAIR[0]), candidate(2, demo.FALSE_PAIR[1])))

    def test_facts_conflict_needs_both_sides_filled_and_different(self):
        base = candidate(1, "Товар")
        gtin8, gtin13 = "20000004", demo.ean13("200000000001")
        self.assertFalse(facts_conflict(base, candidate(2, "Товар", gtin=gtin13, brand=7, package=(Decimal("1"), "kg"))))
        self.assertTrue(facts_conflict(candidate(1, "Т", gtin=gtin13), candidate(2, "Т", gtin=demo.ean13("200000000002"))))
        self.assertTrue(facts_conflict(candidate(1, "Т", brand=1), candidate(2, "Т", brand=2)))
        self.assertTrue(facts_conflict(
            candidate(1, "Т", package=(Decimal("500"), "g")), candidate(2, "Т", package=(Decimal("1"), "kg")),
        ))
        self.assertFalse(facts_conflict(
            candidate(1, "Т", package=(Decimal("10.000"), "pcs")), candidate(2, "Т", package=(Decimal("10"), "pcs")),
        ))
        self.assertTrue(facts_conflict(candidate(1, "Т", model="A1"), candidate(2, "Т", model="A2")))
        self.assertFalse(facts_conflict(candidate(1, "Т", model=" A1 "), candidate(2, "Т", model="A1")))
        # The same GTIN printed as GTIN-8 and zero-padded GTIN-13 is one code.
        self.assertFalse(facts_conflict(candidate(1, "Т", gtin=gtin8), candidate(2, "Т", gtin=gtin8.zfill(13))))

    def test_default_survivor_prefers_a_classified_then_a_more_complete_record(self):
        plain = candidate(5, "Товар")
        self.assertEqual(min([candidate(9, "Товар"), plain], key=target_key), plain)
        filled = candidate(9, "Товар", brand=1, gtin="20000004")
        self.assertEqual(min([plain, filled], key=target_key), filled)
        classified = candidate(12, "Товар", service_generic=False)
        self.assertEqual(min([plain, filled, classified], key=target_key), classified)


class DemoGroupingTests(SimpleTestCase):
    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        cls.candidates = demo_candidates()
        cls.id_of = {item.name: item.id for item in cls.candidates}
        cls.proposals = find_groups(cls.candidates)

    def test_exactly_seven_groups_with_expected_survivors(self):
        found = {
            tuple(sorted(proposal.product_ids)): proposal.target_id for proposal in self.proposals
        }
        expected = {
            tuple(sorted(self.id_of[name] for name in names)): self.id_of[names[0]] for names in demo.GROUPS
        }
        self.assertEqual(found, expected)
        self.assertEqual(sum(len(names) for names in demo.GROUPS), 19)
        self.assertTrue(all(proposal.existing is None for proposal in self.proposals))

    def test_edges_match_the_studied_snapshot(self):
        edges = {(first, second): distance for distance, first, second in find_edges(self.candidates)}
        self.assertEqual(len(edges), 17)

        def distance(first, second):
            return edges.get(tuple(sorted((self.id_of[first], self.id_of[second]))))

        self.assertEqual(distance("Steinhof.PizzaSpezial", "Steinhof PizzaSpezial"), 0)
        self.assertEqual(distance("Steinhof.PizzaSpezial", "Steinof.PizzaSpezial"), 1)
        self.assertEqual(distance("GO EgSB H-Milch 1,5%", "GO FoSB H-Milch 1,5%"), 2)
        self.assertEqual(distance("Eier 10er Freilandh.", "Eier 10er Freiland"), 1)
        # «GO FoSB» joins the milk group through a single edge.
        self.assertEqual(sum(self.id_of["GO FoSB H-Milch 1,5%"] in pair for pair in edges), 1)

    def test_false_pair_hot_dog_and_negative_examples_stay_out(self):
        grouped = {product_id for proposal in self.proposals for product_id in proposal.product_ids}
        expected = {self.id_of[name] for names in demo.GROUPS for name in names}
        self.assertEqual(grouped, expected)
        outside = [item.name for item in self.candidates if item.id not in grouped]
        self.assertEqual(len(outside), len(demo.PRODUCTS) - 19)
        for name in (*demo.FALSE_PAIR, "Pizza Hot Dog", "Demo Joghurt 1,5%", "Demo Wasser 5l", "Eier 6er Freiland",
                     "Reis Langkorn Beutel.", "Kaffee Crema Bohne", "Schoko Riegel Nuss.", "Landbrot geschnitten."):
            self.assertIn(name, outside)

    def test_result_does_not_depend_on_the_input_order(self):
        shuffled = list(self.candidates)
        for seed in range(5):
            random.Random(seed).shuffle(shuffled)
            self.assertEqual(find_groups(shuffled), self.proposals)


class GroupingRuleTests(SimpleTestCase):
    def test_rejected_pair_is_not_joined_directly_or_through_a_third_record(self):
        items = [candidate(1, "Steinhof.PizzaSpezial"), candidate(2, "Steinhof PizzaSpezial"),
                 candidate(3, "Steinof.PizzaSpezial")]
        self.assertEqual([p.product_ids for p in find_groups(items)], [(1, 2, 3)])
        # 1–2 is the closest pair and joins first; 3 may not join a set holding 1.
        self.assertEqual([p.product_ids for p in find_groups(items, rejected={(1, 3)})], [(1, 2)])
        self.assertEqual([p.product_ids for p in find_groups(items, rejected={(1, 2)})], [(1, 3)])
        self.assertEqual(find_groups(items, rejected={(1, 2), (1, 3), (2, 3)}), [])

    def test_conflicting_facts_are_not_joined_through_a_third_record(self):
        items = [candidate(1, "Kaffee Crema Bohnen", brand=1), candidate(2, "Kaffee Crema Bohne"),
                 candidate(3, "Kaffee Crema Bohnen.", brand=2)]
        self.assertEqual([p.product_ids for p in find_groups(items)], [(1, 2)])

    def test_existing_group_only_grows(self):
        items = [candidate(1, "Steinhof.PizzaSpezial"), candidate(2, "Steinhof PizzaSpezial"),
                 candidate(3, "Steinof.PizzaSpezial")]
        self.assertEqual(find_groups(items, existing={"g": {1, 2, 3}}), [])
        proposal, = find_groups(items, existing={"g": {1, 2}})
        self.assertEqual((proposal.existing, proposal.product_ids, proposal.added_ids), ("g", (1, 2, 3), (3,)))

    def test_two_existing_groups_are_never_joined(self):
        items = [candidate(1, "Steinhof.PizzaSpezial"), candidate(2, "Steinhof PizzaSpezial"),
                 candidate(3, "Steinof.PizzaSpezial"), candidate(4, "Steinof PizzaSpezial")]
        self.assertEqual(find_groups(items, existing={"a": {1, 2}, "b": {3, 4}}), [])
        # A newcomer close to both joins exactly one of them, deterministically.
        items.append(candidate(5, "Steinhof-PizzaSpezial"))
        proposal, = find_groups(items, existing={"a": {1, 2}, "b": {3, 4}})
        self.assertEqual((proposal.existing, proposal.added_ids), ("a", (5,)))

    def test_rejection_keeps_a_record_out_of_an_existing_group(self):
        items = [candidate(1, "Steinhof.PizzaSpezial"), candidate(2, "Steinhof PizzaSpezial"),
                 candidate(3, "Steinof.PizzaSpezial")]
        self.assertEqual(find_groups(items, rejected={(2, 3)}, existing={"g": {1, 2}}), [])

    def test_scope_limits_the_search_to_pairs_touching_given_products(self):
        items = [candidate(1, "Steinhof.PizzaSpezial"), candidate(2, "Steinhof PizzaSpezial"),
                 candidate(3, "Zimbo Mettw.fettred."), candidate(4, "Zimbo Mettw.fettre d.")]
        self.assertEqual([p.product_ids for p in find_groups(items, scope={4})], [(3, 4)])
        self.assertEqual(find_groups(items, scope=set()), [])
        self.assertEqual(len(find_groups(items)), 2)


class DemoGuardTests(SimpleTestCase):
    def test_only_test_and_qa_database_names_are_allowed(self):
        for name in ("checkist_qa", "checkist_qa_c1", "test_checkist_qa", "test_checkist_dev"):
            self.assertTrue(demo.allowed_database(name), name)
        for name in ("checkist_dev", "checkist", "postgres", "checkist_qa2", "prod_checkist_qa", ""):
            self.assertFalse(demo.allowed_database(name), name)

    def test_demo_gtins_have_a_valid_checksum(self):
        from recognition.resolution import canonical_gtin

        for spec in demo.PRODUCTS:
            if spec.get("gtin"):
                self.assertIsNotNone(canonical_gtin(spec["gtin"]))
