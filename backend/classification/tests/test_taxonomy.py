from django.test import SimpleTestCase

from classification.taxonomy import SERVICE_KEY, display_name, is_service_name, is_valid_name, name_key


class NameKeyTests(SimpleTestCase):
    def test_case_and_yo_are_folded(self):
        self.assertEqual(name_key("Кефир"), "кефир")
        self.assertEqual(name_key("ЁЛКА"), name_key("елка"))
        self.assertEqual(name_key("Ёлка"), "елка")
        self.assertEqual(name_key("STRASSE"), name_key("Straße"))

    def test_compatibility_forms_are_unified(self):
        # Full-width letters, a ligature and a decomposed "й" are the same name.
        self.assertEqual(name_key("ＳＳＤ"), "ssd")
        self.assertEqual(name_key("ﬁле"), "fiле")
        self.assertEqual(name_key("Чай"), name_key("Чай"))
        self.assertEqual(name_key("Молоко питьевое"), "молоко питьевое")

    def test_every_dash_becomes_a_hyphen(self):
        for dash in "‐‑‒–—−":
            with self.subTest(dash=hex(ord(dash))):
                self.assertEqual(name_key(f"SSD{dash}накопитель"), "ssd-накопитель")
        self.assertEqual(name_key("SSD-накопитель"), "ssd-накопитель")

    def test_whitespace_runs_collapse_and_edges_are_trimmed(self):
        self.assertEqual(name_key("  Сливочное \t\n  масло  "), "сливочное масло")
        self.assertEqual(name_key(""), "")
        self.assertEqual(name_key(None), "")

    def test_punctuation_and_number_are_kept(self):
        self.assertNotEqual(name_key("Яйцо"), name_key("Яйца"))
        self.assertNotEqual(name_key("Сыр"), name_key("Сыры"))
        self.assertNotEqual(name_key("Сок."), name_key("Сок"))
        self.assertNotEqual(name_key("Хлеб и выпечка"), name_key("Хлеб, выпечка"))

    def test_service_key(self):
        self.assertEqual(SERVICE_KEY, "не разобрано")
        for name in ("Не разобрано", "НЕ  РАЗОБРАНО", " не разобрано ", "Не разобрано"):
            with self.subTest(name=name):
                self.assertTrue(is_service_name(name))
        self.assertFalse(is_service_name("Не разобрано."))
        self.assertFalse(is_service_name("Разобрано"))


class DisplayNameTests(SimpleTestCase):
    def test_first_letter_is_capital_and_the_rest_is_kept(self):
        self.assertEqual(display_name("кефир"), "Кефир")
        self.assertEqual(display_name("сливочное Масло"), "Сливочное Масло")
        self.assertEqual(display_name("SSD-накопитель"), "SSD-накопитель")
        self.assertEqual(display_name("ёлочные игрушки"), "Ёлочные игрушки")

    def test_whitespace_is_collapsed_and_trimmed(self):
        self.assertEqual(display_name("  хлеб \n и\tвыпечка "), "Хлеб и выпечка")
        self.assertEqual(display_name(""), "")
        self.assertEqual(display_name(None), "")

    def test_composed_form_is_stored(self):
        self.assertEqual(display_name("чай"), "Чай")
        # Unlike the key, the display name keeps the dash and the letter «ё».
        self.assertEqual(display_name("ёлка—игрушка"), "Ёлка—игрушка")


class ValidNameTests(SimpleTestCase):
    def test_length_is_one_to_hundred_characters(self):
        self.assertTrue(is_valid_name("Я"))
        self.assertTrue(is_valid_name("я" * 100))
        self.assertFalse(is_valid_name("я" * 101))
        for empty in ("", "   ", "\n\t", None):
            with self.subTest(empty=empty):
                self.assertFalse(is_valid_name(empty))
        # Length is counted after the whitespace is collapsed.
        self.assertTrue(is_valid_name("  " + "я" * 100 + "  "))

    def test_a_cyrillic_letter_is_required(self):
        self.assertTrue(is_valid_name("SSD-накопитель"))
        self.assertTrue(is_valid_name("Қазы"))
        for name in ("Milk", "SSD 2.5", "12345", "---", "Käse"):
            with self.subTest(name=name):
                self.assertFalse(is_valid_name(name))

    def test_control_characters_are_rejected(self):
        for char in ("\x00", "\x07", "\x1b", "\x7f", "\x9f"):
            with self.subTest(char=hex(ord(char))):
                self.assertFalse(is_valid_name(f"Кефир{char}"))
                self.assertFalse(is_valid_name(f"Ке{char}фир"))
        # Line breaks and tabs are whitespace: they are collapsed, not rejected.
        self.assertTrue(is_valid_name("Сливочное\nмасло"))
