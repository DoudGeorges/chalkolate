
"""Chalkolate AI whiteboard detection validation tests.

Validates manually recorded AI detection results.
Does not call Gemini or modify application behavior.
"""

import json
import unittest
from pathlib import Path


CASES_PATH = Path(__file__).with_name("whiteboard_cases.json")


class WhiteboardDetectionTests(unittest.TestCase):

    @classmethod
    def setUpClass(cls):
        """Load the test cases once."""
        with open(CASES_PATH, "r", encoding="utf-8") as file:
            cls.cases = json.load(file)

    def test_cases_are_valid(self):
        """Check test case structure and uniqueness."""

        self.assertIsInstance(self.cases, list)
        self.assertGreater(len(self.cases), 0)

        ids = []

        required_fields = [
            "id",
            "category",
            "input",
            "expected_error",
            "actual_error",
            "notes"
        ]

        for case in self.cases:

            for field in required_fields:
                self.assertIn(field, case)

            self.assertIs(type(case["expected_error"]), bool)

            actual = case["actual_error"]
            self.assertTrue(
                actual is None or type(actual) is bool
            )

            ids.append(case["id"])

        self.assertEqual(
            len(ids),
            len(set(ids)),
            "Duplicate test case IDs found."
        )

    def test_detection_accuracy(self):
        """Compare expected and recorded detection outcomes."""

        tested = [
            case for case in self.cases
            if case["actual_error"] is not None
        ]

        if not tested:
            self.skipTest(
                "No recorded AI results yet."
            )

        for case in tested:
            with self.subTest(case=case["id"]):
                self.assertEqual(
                    case["actual_error"],
                    case["expected_error"],
                    f"Detection mismatch: {case['id']}"
                )

    def test_accuracy_summary(self):
        """Print accuracy for recorded test cases."""

        tested = [
            case for case in self.cases
            if case["actual_error"] is not None
        ]

        if not tested:
            self.skipTest(
                "No recorded AI results yet."
            )

        correct = sum(
            case["actual_error"] == case["expected_error"]
            for case in tested
        )

        accuracy = (correct / len(tested)) * 100

        print("\nChalkolate AI Detection Summary")
        print("--------------------------------")
        print(f"Total scenarios: {len(self.cases)}")
        print(f"Tested scenarios: {len(tested)}")
        print(f"Correct detections: {correct}")
        print(f"Accuracy: {accuracy:.1f}%")

        self.assertGreaterEqual(accuracy, 0)


if __name__ == "__main__":
    unittest.main()
