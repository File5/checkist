from django.test import SimpleTestCase

from stores.normalize import ADDRESS_KEY_MAX_LENGTH, address_key, address_language, normalize_address


class NormalizeAddressTests(SimpleTestCase):
    def test_lowercases(self):
        self.assertEqual(normalize_address("УЛ ЛЕНИНА Musterstraße"), "ул ленина musterstraße")

    def test_removes_punctuation(self):
        self.assertEqual(
            normalize_address("г. Алматы, ул. Абая, д. 10/2 (ТЦ «Пример») № 5"),
            "г алматы ул абая д 10 2 тц пример 5",
        )

    def test_punctuation_separates_words_like_whitespace(self):
        self.assertEqual(normalize_address("ул.Абая,10"), normalize_address("ул. Абая, 10"))

    def test_collapses_whitespace(self):
        self.assertEqual(normalize_address("  ул\tАбая \n\n 10 а  "), "ул абая 10 а")

    def test_keeps_letters_and_digits_of_other_scripts(self):
        self.assertEqual(normalize_address("Әл-Фараби даңғылы, 77"), "әл фараби даңғылы 77")

    def test_equal_for_composed_and_decomposed_input(self):
        self.assertEqual(normalize_address("й"), normalize_address("й"))

    def test_empty_input(self):
        self.assertEqual(normalize_address(""), "")
        self.assertEqual(normalize_address(None), "")
        self.assertEqual(normalize_address(" .,;- "), "")


class AddressKeyTests(SimpleTestCase):
    KK = "Алматы қ., Абай даңғ., 10"
    RU = "г. Алматы, пр. Абая, 10"

    def test_uses_raw_address_without_language_variants(self):
        self.assertEqual(address_key("Musterstr. 1, 10115 Berlin"), "musterstr 1 10115 berlin")
        self.assertEqual(address_key("Musterstr. 1, 10115 Berlin", {}), "musterstr 1 10115 berlin")
        self.assertEqual(address_key("Musterstr. 1, 10115 Berlin", None), "musterstr 1 10115 berlin")

    def test_same_key_for_case_punctuation_and_spacing_variants(self):
        self.assertEqual(
            address_key("Г.АЛМАТЫ,  ПР.АБАЯ,10"),
            address_key("г. Алматы, пр. Абая, 10"),
        )

    def test_bilingual_key_uses_first_language_code_alphabetically(self):
        self.assertEqual(address_language({"ru": self.RU, "kk": self.KK}), "kk")
        self.assertEqual(
            address_key(self.RU, {"ru": self.RU, "kk": self.KK}),
            "алматы қ абай даңғ 10",
        )

    def test_bilingual_key_does_not_depend_on_input_order(self):
        keys = {
            address_key(self.KK, {"kk": self.KK, "ru": self.RU}),
            address_key(self.KK, {"ru": self.RU, "kk": self.KK}),
            address_key(self.RU, {"kk": self.KK, "ru": self.RU}),
            address_key(self.RU, {"ru": self.RU, "kk": self.KK}),
        }
        self.assertEqual(keys, {"алматы қ абай даңғ 10"})

    def test_language_code_case_does_not_change_choice(self):
        self.assertEqual(
            address_key(self.RU, {"RU": self.RU, "kk": self.KK}),
            address_key(self.RU, {"ru": self.RU, "KK": self.KK}),
        )

    def test_blank_language_variant_is_skipped(self):
        self.assertEqual(address_key(self.RU, {"kk": " ", "ru": self.RU}), "г алматы пр абая 10")
        self.assertEqual(address_key(self.RU, {"kk": "", "ru": None}), "г алматы пр абая 10")

    def test_key_fits_model_field(self):
        key = address_key("улица " * 100)
        self.assertLessEqual(len(key), ADDRESS_KEY_MAX_LENGTH)
        self.assertEqual(key, key.strip())
        self.assertTrue(key.startswith("улица улица"))
